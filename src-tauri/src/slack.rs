//! Slack backend integration.
//!
//! Wraps `slack_core::SlackClient` (one per workspace) and exposes it as `sl_*`
//! Tauri commands, prefixed so they never collide with the iMessage or `tg_*`
//! commands. Realtime updates are forwarded to the webview as a single
//! `sl:core-event` stream, mirroring the Telegram bridge.
//!
//! Like the Telegram side, initialization is deliberately non-fatal: with no
//! tokens stored the app runs as before and every `sl_*` command returns a
//! clear error rather than failing startup.
//!
//! ## Credentials
//! Slack needs two tokens per workspace: a user token (`xoxp-`) so Web API
//! calls act *as the user*, and an app-level token (`xapp-`) to open the Socket
//! Mode stream. They are held in the macOS Keychain via the same
//! [`SecretStore`] the Telegram sessions use — never on disk in plaintext.
//!
//! One keychain entry holds all workspaces rather than one per workspace: the
//! app is unsigned, so each distinct entry can trigger its own trust prompt.

use std::collections::HashMap;
use std::sync::Arc;

use cache::secrets::KeychainSecretStore;
use serde::{Deserialize, Serialize};
use shared::secrets::SecretStore;
use slack_core::{ChatInfo, SlackClient, SlackMessage};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;

/// Keychain entry holding every configured workspace.
const SECRET_KEY: &str = "slack.workspaces";

/// The TUI client's plaintext config, imported once on first use.
const LEGACY_CONFIG: &str = ".slack_config.json";

// --- stored shape ----------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredWorkspace {
    id: String,
    name: String,
    token: String,
    app_token: String,
}

/// What the webview is allowed to see — never the tokens.
#[derive(Debug, Clone, Serialize)]
pub struct WorkspaceInfo {
    id: String,
    name: String,
    connected: bool,
}

#[derive(Debug, Serialize)]
pub struct SlackStatus {
    configured: bool,
    workspaces: Vec<WorkspaceInfo>,
    /// True when tokens were just migrated out of the plaintext TUI config, so
    /// the UI can tell the user they may delete that file.
    imported_from_file: bool,
}

// --- managed state ---------------------------------------------------------

#[derive(Default)]
pub struct SlackState {
    /// Connected clients keyed by workspace id. Absent means "not connected".
    clients: Mutex<HashMap<String, Arc<SlackClient>>>,
}

impl SlackState {
    pub fn new() -> Self {
        Self::default()
    }
}

// --- secret storage --------------------------------------------------------

fn store() -> KeychainSecretStore {
    KeychainSecretStore::new()
}

fn load_workspaces() -> Result<Vec<StoredWorkspace>, String> {
    let raw = store()
        .get(SECRET_KEY)
        .map_err(|e| format!("keychain read failed: {e}"))?;
    match raw {
        Some(bytes) => {
            serde_json::from_slice(&bytes).map_err(|e| format!("stored workspaces are corrupt: {e}"))
        }
        None => Ok(Vec::new()),
    }
}

fn save_workspaces(list: &[StoredWorkspace]) -> Result<(), String> {
    let bytes = serde_json::to_vec(list).map_err(|e| format!("serialize failed: {e}"))?;
    store()
        .set(SECRET_KEY, &bytes)
        .map_err(|e| format!("keychain write failed: {e}"))
}

// --- one-time import from the TUI's plaintext config -----------------------

#[derive(Deserialize)]
struct LegacyWorkspace {
    name: String,
    token: String,
    app_token: String,
}

#[derive(Deserialize)]
struct LegacyConfig {
    workspaces: Vec<LegacyWorkspace>,
}

fn slugify(name: &str) -> String {
    name.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' })
        .collect()
}

/// Import `~/.slack_config.json` if present and nothing is stored yet.
///
/// The file is deliberately left untouched: the TUI still reads it, and the
/// user decides when to remove the plaintext copy.
fn import_legacy_if_empty() -> Result<bool, String> {
    if !load_workspaces()?.is_empty() {
        return Ok(false);
    }
    let Some(home) = std::env::var_os("HOME") else {
        return Ok(false);
    };
    let path = std::path::Path::new(&home).join(LEGACY_CONFIG);
    if !path.exists() {
        return Ok(false);
    }

    let raw = std::fs::read(&path).map_err(|e| format!("could not read {LEGACY_CONFIG}: {e}"))?;
    let parsed: LegacyConfig =
        serde_json::from_slice(&raw).map_err(|e| format!("could not parse {LEGACY_CONFIG}: {e}"))?;

    let imported: Vec<StoredWorkspace> = parsed
        .workspaces
        .into_iter()
        .filter(|w| !w.token.is_empty() && !w.app_token.is_empty())
        .map(|w| StoredWorkspace {
            id: slugify(&w.name),
            name: w.name,
            token: w.token,
            app_token: w.app_token,
        })
        .collect();

    if imported.is_empty() {
        return Ok(false);
    }
    save_workspaces(&imported)?;
    log::info!("slack: imported {} workspace(s) from {LEGACY_CONFIG}", imported.len());
    Ok(true)
}

// --- commands --------------------------------------------------------------

#[tauri::command]
pub async fn sl_status(state: State<'_, SlackState>) -> Result<SlackStatus, String> {
    let imported_from_file = import_legacy_if_empty().unwrap_or(false);
    let stored = load_workspaces()?;
    let connected = state.clients.lock().await;
    Ok(SlackStatus {
        configured: !stored.is_empty(),
        workspaces: stored
            .iter()
            .map(|w| WorkspaceInfo {
                id: w.id.clone(),
                name: w.name.clone(),
                connected: connected.contains_key(&w.id),
            })
            .collect(),
        imported_from_file,
    })
}

/// Add or replace a workspace's tokens.
#[tauri::command]
pub async fn sl_save_workspace(
    name: String,
    token: String,
    app_token: String,
) -> Result<WorkspaceInfo, String> {
    if !token.starts_with("xoxp-") && !token.starts_with("xoxb-") {
        return Err("expected a user token starting with xoxp- (or a bot token, xoxb-)".into());
    }
    if !app_token.starts_with("xapp-") {
        return Err("expected an app-level token starting with xapp-".into());
    }

    let id = slugify(&name);
    let mut list = load_workspaces()?;
    list.retain(|w| w.id != id);
    list.push(StoredWorkspace {
        id: id.clone(),
        name: name.clone(),
        token,
        app_token,
    });
    save_workspaces(&list)?;
    Ok(WorkspaceInfo {
        id,
        name,
        connected: false,
    })
}

#[tauri::command]
pub async fn sl_remove_workspace(
    workspace_id: String,
    state: State<'_, SlackState>,
) -> Result<(), String> {
    if let Some(client) = state.clients.lock().await.remove(&workspace_id) {
        client.shutdown().await;
    }
    let mut list = load_workspaces()?;
    list.retain(|w| w.id != workspace_id);
    save_workspaces(&list)
}

/// Connect a workspace: open Socket Mode and start bridging its updates.
#[tauri::command]
pub async fn sl_connect(
    workspace_id: String,
    app: AppHandle,
    state: State<'_, SlackState>,
) -> Result<(), String> {
    if state.clients.lock().await.contains_key(&workspace_id) {
        return Ok(());
    }
    let stored = load_workspaces()?;
    let ws = stored
        .iter()
        .find(|w| w.id == workspace_id)
        .ok_or_else(|| format!("unknown workspace: {workspace_id}"))?;

    let client = SlackClient::new(&ws.token, &ws.app_token)
        .await
        .map_err(|e| format!("slack connect failed: {e}"))?;
    let client = Arc::new(client);

    client
        .start_event_listener(ws.app_token.clone())
        .await
        .map_err(|e| format!("slack socket mode failed: {e}"))?;

    tauri::async_runtime::spawn(bridge_events(
        app,
        workspace_id.clone(),
        Arc::clone(&client),
    ));
    state.clients.lock().await.insert(workspace_id, client);
    Ok(())
}

async fn with_client(
    state: &State<'_, SlackState>,
    workspace_id: &str,
) -> Result<Arc<SlackClient>, String> {
    state
        .clients
        .lock()
        .await
        .get(workspace_id)
        .cloned()
        .ok_or_else(|| format!("workspace {workspace_id} is not connected"))
}

#[tauri::command]
pub async fn sl_conversations(
    workspace_id: String,
    state: State<'_, SlackState>,
) -> Result<Vec<ChatInfo>, String> {
    with_client(&state, &workspace_id)
        .await?
        .get_conversations()
        .await
        .map_err(|e| format!("slack conversations failed: {e}"))
}

#[tauri::command]
pub async fn sl_history(
    workspace_id: String,
    channel_id: String,
    limit: usize,
    state: State<'_, SlackState>,
) -> Result<Vec<SlackMessage>, String> {
    with_client(&state, &workspace_id)
        .await?
        .get_conversation_history(&channel_id, limit)
        .await
        .map_err(|e| format!("slack history failed: {e}"))
}

#[tauri::command]
pub async fn sl_send(
    workspace_id: String,
    channel_id: String,
    text: String,
    thread_ts: Option<String>,
    state: State<'_, SlackState>,
) -> Result<(), String> {
    with_client(&state, &workspace_id)
        .await?
        .send_message(&channel_id, &text, thread_ts.as_deref())
        .await
        .map_err(|e| format!("slack send failed: {e}"))
}

// --- event bridge ----------------------------------------------------------

/// Forward one workspace's updates to the webview until it disconnects.
///
/// The payload carries the workspace id so the frontend can namespace GUIDs the
/// same way Telegram namespaces by account.
async fn bridge_events(app: AppHandle, workspace_id: String, client: Arc<SlackClient>) {
    let mut rx = client.subscribe();
    loop {
        match rx.recv().await {
            Ok(update) => {
                let payload = serde_json::json!({
                    "workspace_id": workspace_id,
                    "update": update,
                });
                if let Err(e) = app.emit("sl:core-event", &payload) {
                    log::warn!("slack: emit failed: {e}");
                }
            }
            Err(tokio::sync::broadcast::error::RecvError::Lagged(missed)) => {
                log::warn!("slack: event bridge lagged by {missed}");
                let _ = app.emit(
                    "sl:core-event",
                    serde_json::json!({ "workspace_id": workspace_id, "kind": "lagged" }),
                );
            }
            Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
        }
    }
}
