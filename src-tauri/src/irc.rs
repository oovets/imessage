//! IRC backend integration.
//!
//! Wraps `irc_core::IrcClient` (one per network) and exposes it as `irc_*`
//! Tauri commands. Realtime updates are forwarded to the webview as a single
//! `irc:core-event` stream, mirroring the Slack bridge.
//!
//! The intended setup is a bouncer — IRCCloud's in particular — rather than a
//! direct network connection: the bouncer holds the real session and replays
//! what the app missed while it was closed, and `irc-core` keeps a local log
//! under the app data dir so a conversation opens with history.
//!
//! ## Credentials
//! Network settings, including the server/bouncer password, live in the
//! keychain via the same [`SecretStore`] Telegram and Slack use — one entry
//! for all networks, since each distinct entry can prompt on unsigned builds.
//! The password is never sent back to the webview.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use cache::secrets::KeychainSecretStore;
use irc_core::{BufferInfo, History, IrcClient, IrcConfig, IrcMessage};
use serde::{Deserialize, Serialize};
use shared::secrets::SecretStore;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Mutex;

/// Keychain entry holding every configured network.
const SECRET_KEY: &str = "irc.networks";

// --- stored shape ----------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredNetwork {
    id: String,
    name: String,
    host: String,
    port: u16,
    tls: bool,
    nick: String,
    #[serde(default)]
    username: String,
    #[serde(default)]
    realname: String,
    #[serde(default)]
    password: String,
    /// Identifies this app to IRCCloud's bouncer, so it replays exactly what
    /// this client missed. Generated once per network.
    #[serde(default)]
    client_id: String,
}

/// What the webview is allowed to see — never the password.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkInfo {
    id: String,
    name: String,
    host: String,
    port: u16,
    tls: bool,
    nick: String,
    has_password: bool,
    /// Registered with the server right now (not just "client started").
    connected: bool,
    /// The nick the server actually gave us, once connected.
    current_nick: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct IrcStatus {
    configured: bool,
    networks: Vec<NetworkInfo>,
}

// --- managed state ---------------------------------------------------------

#[derive(Default)]
pub struct IrcState {
    /// Running clients keyed by network id. Absent means "not started".
    clients: Mutex<HashMap<String, Arc<IrcClient>>>,
}

impl IrcState {
    pub fn new() -> Self {
        Self::default()
    }
}

// --- secret storage --------------------------------------------------------

fn store() -> KeychainSecretStore {
    KeychainSecretStore::new()
}

fn load_networks() -> Result<Vec<StoredNetwork>, String> {
    let raw = store()
        .get(SECRET_KEY)
        .map_err(|e| format!("keychain read failed: {e}"))?;
    match raw {
        Some(bytes) => {
            serde_json::from_slice(&bytes).map_err(|e| format!("stored IRC networks are corrupt: {e}"))
        }
        None => Ok(Vec::new()),
    }
}

fn save_networks(list: &[StoredNetwork]) -> Result<(), String> {
    let bytes = serde_json::to_vec(list).map_err(|e| format!("serialize failed: {e}"))?;
    store()
        .set(SECRET_KEY, &bytes)
        .map_err(|e| format!("keychain write failed: {e}"))
}

fn slugify(name: &str) -> String {
    let slug: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' })
        .collect();
    // The id is the account segment of `irc:<network>:<buffer>` GUIDs, so it
    // must never be empty or contain a colon (slugify already rules that out).
    if slug.trim_matches('-').is_empty() {
        "irc".into()
    } else {
        slug
    }
}

/// A short id that is unique to this install, for IRCCloud's per-client
/// backlog tracking. Two machines sharing one id would split the replay
/// between them.
fn new_client_id() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    let mut n = nanos ^ (u128::from(std::process::id()) << 64);
    let mut id = String::from("messages-");
    for _ in 0..8 {
        let digit = (n % 36) as u32;
        id.push(char::from_digit(digit, 36).unwrap_or('0'));
        n /= 36;
    }
    id
}

fn history_dir(app: &AppHandle, network_id: &str) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?;
    Ok(base.join("irc").join(network_id))
}

fn info(net: &StoredNetwork, client: Option<&Arc<IrcClient>>) -> NetworkInfo {
    let connected = client.is_some_and(|c| c.is_connected());
    NetworkInfo {
        id: net.id.clone(),
        name: net.name.clone(),
        host: net.host.clone(),
        port: net.port,
        tls: net.tls,
        nick: net.nick.clone(),
        has_password: !net.password.is_empty(),
        connected,
        current_nick: client.filter(|_| connected).map(|c| c.nick()),
    }
}

// --- commands --------------------------------------------------------------

#[tauri::command]
pub async fn irc_status(state: State<'_, IrcState>) -> Result<IrcStatus, String> {
    let stored = load_networks()?;
    let clients = state.clients.lock().await;
    Ok(IrcStatus {
        configured: !stored.is_empty(),
        networks: stored.iter().map(|n| info(n, clients.get(&n.id))).collect(),
    })
}

/// Add a network, or update one (matched by name). An empty password on an
/// update keeps the stored one, so editing the nick doesn't mean pasting the
/// bouncer password again. A running client is restarted with the new settings.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn irc_save_network(
    name: String,
    host: String,
    port: u16,
    tls: bool,
    nick: String,
    username: Option<String>,
    realname: Option<String>,
    password: Option<String>,
    app: AppHandle,
    state: State<'_, IrcState>,
) -> Result<NetworkInfo, String> {
    let name = name.trim().to_string();
    let host = host.trim().to_string();
    let nick = nick.trim().to_string();
    if name.is_empty() {
        return Err("give the network a name".into());
    }
    if host.is_empty() || host.contains(char::is_whitespace) {
        return Err("expected a host name, e.g. bnc.irccloud.com".into());
    }
    if port == 0 {
        return Err("expected a port, e.g. 6697".into());
    }
    if nick.is_empty() || nick.contains([' ', ',', ':', '\r', '\n']) || nick.starts_with('#') {
        return Err("expected a nick without spaces".into());
    }

    let id = slugify(&name);
    let mut list = load_networks()?;
    let previous = list.iter().position(|n| n.id == id).map(|i| list.remove(i));
    let password = password
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .or_else(|| previous.as_ref().map(|p| p.password.clone()))
        .unwrap_or_default();
    let client_id = previous
        .as_ref()
        .map(|p| p.client_id.clone())
        .filter(|c| !c.is_empty())
        .unwrap_or_else(new_client_id);
    let username = username
        .map(|u| u.trim().to_string())
        .filter(|u| !u.is_empty())
        .unwrap_or_else(|| nick.clone());
    let realname = realname
        .map(|r| r.trim().to_string())
        .filter(|r| !r.is_empty())
        .unwrap_or_else(|| nick.clone());

    let net = StoredNetwork {
        id: id.clone(),
        name,
        host,
        port,
        tls,
        nick,
        username,
        realname,
        password,
        client_id,
    };
    list.push(net.clone());
    save_networks(&list)?;

    // Restart a running client so the new settings take effect.
    let restart = state.clients.lock().await.remove(&id);
    if let Some(old) = restart {
        old.shutdown().await;
        start_client(&app, &state, &net).await?;
    }
    let clients = state.clients.lock().await;
    Ok(info(&net, clients.get(&id)))
}

#[tauri::command]
pub async fn irc_remove_network(
    network_id: String,
    state: State<'_, IrcState>,
) -> Result<(), String> {
    if let Some(client) = state.clients.lock().await.remove(&network_id) {
        client.shutdown().await;
    }
    let mut list = load_networks()?;
    list.retain(|n| n.id != network_id);
    save_networks(&list)
}

/// Start a network's client: load its local history and begin connecting in
/// the background. Returns as soon as the history is loaded — registration
/// is reported later as a `Connected` event.
#[tauri::command]
pub async fn irc_connect(
    network_id: String,
    app: AppHandle,
    state: State<'_, IrcState>,
) -> Result<(), String> {
    if state.clients.lock().await.contains_key(&network_id) {
        return Ok(());
    }
    let stored = load_networks()?;
    let net = stored
        .iter()
        .find(|n| n.id == network_id)
        .ok_or_else(|| format!("unknown IRC network: {network_id}"))?;
    start_client(&app, &state, net).await
}

async fn start_client(
    app: &AppHandle,
    state: &State<'_, IrcState>,
    net: &StoredNetwork,
) -> Result<(), String> {
    let dir = history_dir(app, &net.id)?;
    // Reading the logs is blocking file I/O; keep it off the async workers.
    let history = tauri::async_runtime::spawn_blocking(move || History::open(dir))
        .await
        .map_err(|e| format!("history load panicked: {e}"))?
        .map_err(|e| format!("could not open IRC history: {e}"))?;

    let password = (!net.password.is_empty())
        .then(|| irc_core::with_irccloud_client_id(&net.password, &net.client_id));
    let client = Arc::new(IrcClient::start(
        IrcConfig {
            host: net.host.clone(),
            port: net.port,
            tls: net.tls,
            nick: net.nick.clone(),
            username: if net.username.is_empty() { net.nick.clone() } else { net.username.clone() },
            realname: if net.realname.is_empty() { net.nick.clone() } else { net.realname.clone() },
            password,
        },
        history,
    ));

    let mut clients = state.clients.lock().await;
    if clients.contains_key(&net.id) {
        // Lost a race with a concurrent connect; drop ours (shuts it down).
        return Ok(());
    }
    tauri::async_runtime::spawn(bridge_events(app.clone(), net.id.clone(), Arc::clone(&client)));
    clients.insert(net.id.clone(), client);
    Ok(())
}

async fn with_client(
    state: &State<'_, IrcState>,
    network_id: &str,
) -> Result<Arc<IrcClient>, String> {
    state
        .clients
        .lock()
        .await
        .get(network_id)
        .cloned()
        .ok_or_else(|| format!("IRC network {network_id} is not started"))
}

/// Channels and queries known for a network, from its local history — they
/// are listed even before (or without) a live connection.
#[tauri::command]
pub async fn irc_buffers(
    network_id: String,
    state: State<'_, IrcState>,
) -> Result<Vec<BufferInfo>, String> {
    Ok(with_client(&state, &network_id).await?.buffers())
}

#[tauri::command]
pub async fn irc_history(
    network_id: String,
    buffer: String,
    limit: usize,
    state: State<'_, IrcState>,
) -> Result<Vec<IrcMessage>, String> {
    Ok(with_client(&state, &network_id).await?.history(&buffer, limit))
}

/// Send composer input to a buffer: plain lines as messages, `/me`, `/join`,
/// `/msg` and friends as commands.
#[tauri::command]
pub async fn irc_send(
    network_id: String,
    buffer: String,
    text: String,
    state: State<'_, IrcState>,
) -> Result<(), String> {
    with_client(&state, &network_id)
        .await?
        .send_input(&buffer, &text)
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub async fn irc_open_query(
    network_id: String,
    nick: String,
    state: State<'_, IrcState>,
) -> Result<BufferInfo, String> {
    with_client(&state, &network_id)
        .await?
        .open_query(&nick)
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub async fn irc_close_buffer(
    network_id: String,
    buffer: String,
    state: State<'_, IrcState>,
) -> Result<(), String> {
    with_client(&state, &network_id)
        .await?
        .close_buffer(&buffer)
        .map_err(|e| format!("{e:#}"))
}

// --- IRCCloud history import -------------------------------------------------

/// IRCCloud login for the import, `uid: <email>` / `pw: <password>`.
const IRCCLOUD_CREDENTIALS: &str = ".irc";
/// Messages to import per buffer: what the local history keeps anyway.
const IMPORT_PER_BUFFER: usize = irc_core::HISTORY_KEEP;
/// Backlog pages (100 events each) to read per buffer at most. Quiet channels
/// are mostly joins and quits, so 500 messages can lie years back; this caps
/// one buffer at roughly half a minute.
const IMPORT_MAX_PAGES: usize = 100;

#[derive(Debug, Serialize)]
pub struct ImportedBuffer {
    name: String,
    added: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    /// The IRCCloud network the history came from.
    irccloud_network: String,
    buffers: Vec<ImportedBuffer>,
}

/// One-time import of what IRCCloud already stored for this network: the
/// channels the bouncer joined us to, and the network's queries. The login
/// comes from `~/.irc` and is used for this import only, never stored.
#[tauri::command]
pub async fn irc_import_irccloud(
    network_id: String,
    app: AppHandle,
    state: State<'_, IrcState>,
) -> Result<ImportReport, String> {
    use irc_core::irccloud;

    let client = with_client(&state, &network_id).await?;
    let home = std::env::var_os("HOME").ok_or("no HOME directory")?;
    let path = std::path::Path::new(&home).join(IRCCLOUD_CREDENTIALS);
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| format!("could not read ~/{IRCCLOUD_CREDENTIALS}: {e}"))?;
    let creds = irccloud::parse_credentials(&raw)
        .map_err(|e| format!("~/{IRCCLOUD_CREDENTIALS}: {e}"))?;

    let session = irccloud::Session::login(&creds).await.map_err(|e| format!("{e:#}"))?;
    let servers = session.servers().await.map_err(|e| format!("{e:#}"))?;

    let ours: Vec<String> = client
        .buffers()
        .into_iter()
        .filter(|b| b.kind == irc_core::BufferKind::Channel)
        .map(|b| b.name)
        .collect();
    let server = irccloud::pick_server(&servers, &ours).ok_or_else(|| {
        let names: Vec<&str> = servers.iter().map(|s| s.name.as_str()).collect();
        format!(
            "could not tell which IRCCloud network this is (none, or several, share its channels). IRCCloud has: {}",
            names.join(", ")
        )
    })?;

    // Channels we are in now, plus every query. Channels left long ago would
    // come back as chats you are not in.
    let joined: std::collections::HashSet<String> =
        ours.iter().map(|c| irc_core::proto::irc_lower(c)).collect();
    let wanted: Vec<&irccloud::CloudBuffer> = server
        .buffers
        .iter()
        .filter(|b| {
            b.kind == irc_core::BufferKind::Query || joined.contains(&irc_core::proto::irc_lower(&b.name))
        })
        .collect();

    let mut report = ImportReport {
        irccloud_network: server.name.clone(),
        buffers: Vec::new(),
    };
    let total = wanted.len();
    for (index, buffer) in wanted.into_iter().enumerate() {
        let progress = |messages: usize| {
            let _ = app.emit(
                "irc:import-progress",
                serde_json::json!({
                    "network_id": network_id,
                    "buffer": buffer.name,
                    "index": index,
                    "total": total,
                    "messages": messages,
                }),
            );
        };
        progress(0);
        let messages = session
            .backlog(server.cid, buffer, IMPORT_PER_BUFFER, IMPORT_MAX_PAGES, progress)
            .await
            .map_err(|e| format!("{}: {e:#}", buffer.name))?;
        let added = client.import_history(&buffer.name, buffer.kind, messages);
        log::info!("irc: imported {added} message(s) into {}", buffer.name);
        report.buffers.push(ImportedBuffer {
            name: buffer.name.clone(),
            added,
        });
    }
    Ok(report)
}

// --- event bridge ----------------------------------------------------------

/// Forward one network's updates to the webview until its client stops.
async fn bridge_events(app: AppHandle, network_id: String, client: Arc<IrcClient>) {
    let mut rx = client.subscribe();
    // The bridge must not keep the client alive after it is removed.
    drop(client);
    loop {
        match rx.recv().await {
            Ok(update) => {
                let payload = serde_json::json!({
                    "network_id": network_id,
                    "update": update,
                });
                if let Err(e) = app.emit("irc:core-event", &payload) {
                    log::warn!("irc: emit failed: {e}");
                }
            }
            Err(tokio::sync::broadcast::error::RecvError::Lagged(missed)) => {
                log::warn!("irc: event bridge lagged by {missed}");
                let _ = app.emit(
                    "irc:core-event",
                    serde_json::json!({ "network_id": network_id, "kind": "lagged" }),
                );
            }
            Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs_are_usable_as_guid_segments() {
        assert_eq!(slugify("IRCCloud Libera"), "irccloud-libera");
        assert_eq!(slugify("::"), "irc");
        assert!(!slugify("a:b").contains(':'));
    }

    #[test]
    fn client_ids_look_like_irccloud_wants() {
        let id = new_client_id();
        assert!(id.starts_with("messages-"));
        assert!(!id.contains([' ', ':']));
    }
}
