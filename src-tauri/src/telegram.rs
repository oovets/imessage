//! Telegram backend integration.
//!
//! Starts `telegram_core::Core` and exposes its read operations as `tg_*`
//! Tauri commands (prefixed so they never collide with the host's iMessage
//! commands). Core events are forwarded to the webview as a single
//! `tg:core-event` stream, mirroring how the iMessage side uses its WebSocket.
//!
//! Initialization is deliberately non-fatal: if Telegram isn't configured
//! (no API credentials) or fails to start, the app still runs as the plain
//! Messages client and every `tg_*` command returns a clear error.

use std::path::PathBuf;
use std::sync::Arc;

use cache::secrets::KeychainSecretStore;
use chrono::{DateTime, Utc};
use shared::model::{Account, AccountId, Chat, ChatId, Message, MessageId, UserId};
use shared::AppConfig;
use tauri::{AppHandle, Emitter, State};
use telegram_core::Core;

/// Managed state holding the (optional) running Telegram core.
pub struct TelegramState {
    core: Option<Arc<Core>>,
}

impl TelegramState {
    /// The running core, or a user-facing error when Telegram is unavailable.
    fn core(&self) -> Result<Arc<Core>, String> {
        self.core
            .clone()
            .ok_or_else(|| "Telegram is not configured on this device".to_string())
    }
}

/// Locate a repo-local `config/default.toml` during development.
fn dev_config_path() -> Option<PathBuf> {
    let candidates = [
        PathBuf::from("config/default.toml"),
        PathBuf::from("../config/default.toml"),
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../config/default.toml"),
    ];
    candidates.into_iter().find(|p| p.exists())
}

/// Try to start the Telegram core. Returns state with `core: None` (and logs)
/// if Telegram is not configured or fails to start — never panics the app.
pub async fn init(app: &AppHandle) -> TelegramState {
    let mut config = match AppConfig::load(dev_config_path().as_deref()) {
        Ok(config) => config,
        Err(e) => {
            log::warn!("telegram: config load failed, disabling: {e}");
            return TelegramState { core: None };
        }
    };
    // Compile-time baked credentials: set TG_API_ID / TG_API_HASH when building
    // a release and they're embedded, so the bundled app works without any
    // runtime environment variables. Nothing secret is committed to the repo.
    if config.telegram.api_id == 0 {
        if let Some(id) = option_env!("TG_API_ID").and_then(|s| s.trim().parse::<i32>().ok()) {
            config.telegram.api_id = id;
        }
    }
    if config.telegram.api_hash.is_empty() {
        if let Some(hash) = option_env!("TG_API_HASH") {
            config.telegram.api_hash = hash.trim().to_owned();
        }
    }
    if config.require_api_credentials().is_err() {
        log::info!("telegram: no API credentials (TG_API_ID/TG_API_HASH), disabling");
        return TelegramState { core: None };
    }

    let secrets = Arc::new(KeychainSecretStore::new());
    match Core::start(config, secrets).await {
        Ok(core) => {
            log::info!("telegram: core started");
            let bridge_app = app.clone();
            let bridge_core = Arc::clone(&core);
            tauri::async_runtime::spawn(bridge_events(bridge_app, bridge_core));
            TelegramState { core: Some(core) }
        }
        Err(e) => {
            log::warn!("telegram: core failed to start, disabling: {e}");
            TelegramState { core: None }
        }
    }
}

/// Forward core events to the webview until the app shuts down.
async fn bridge_events(app: AppHandle, core: Arc<Core>) {
    let mut rx = core.subscribe();
    loop {
        match rx.recv().await {
            Ok(event) => {
                if let Err(e) = app.emit("tg:core-event", &event) {
                    log::warn!("telegram: emit failed: {e}");
                }
            }
            Err(tokio::sync::broadcast::error::RecvError::Lagged(missed)) => {
                log::warn!("telegram: event bridge lagged by {missed}");
                let _ = app.emit("tg:core-event", serde_json::json!({ "kind": "lagged" }));
            }
            Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
        }
    }
}

fn data_url(bytes: &[u8], mime: &str) -> String {
    let encoded = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, bytes);
    format!("data:{mime};base64,{encoded}")
}

// ----- read commands (Fas 1) ----------------------------------------------

/// Whether Telegram is available (configured and running).
#[tauri::command]
pub fn tg_status(state: State<'_, TelegramState>) -> bool {
    state.core.is_some()
}

#[tauri::command]
pub async fn tg_list_accounts(
    state: State<'_, TelegramState>,
) -> Result<Vec<Account>, String> {
    let core = state.core()?;
    core.accounts.list().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn tg_chat_list(
    state: State<'_, TelegramState>,
    account_id: AccountId,
) -> Result<Vec<Chat>, String> {
    let core = state.core()?;
    core.chat_list(account_id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn tg_messages(
    state: State<'_, TelegramState>,
    account_id: AccountId,
    chat_id: ChatId,
    before_date: Option<DateTime<Utc>>,
    before_id: Option<MessageId>,
    limit: Option<u32>,
) -> Result<Vec<Message>, String> {
    let core = state.core()?;
    let before = match (before_date, before_id) {
        (Some(date), Some(id)) => Some((date, id)),
        _ => None,
    };
    core.messages(account_id, chat_id, before, limit.unwrap_or(50))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn tg_avatar_data_url(
    state: State<'_, TelegramState>,
    account_id: AccountId,
    chat_id: ChatId,
) -> Result<Option<String>, String> {
    let core = state.core()?;
    let bytes = core
        .avatar_bytes(account_id, chat_id)
        .await
        .map_err(|e| e.to_string())?;
    Ok(bytes.map(|b| data_url(&b, "image/jpeg")))
}

#[tauri::command]
pub async fn tg_user_avatar_data_url(
    state: State<'_, TelegramState>,
    account_id: AccountId,
    user_id: UserId,
) -> Result<Option<String>, String> {
    let core = state.core()?;
    let bytes = core
        .user_avatar_bytes(account_id, user_id)
        .await
        .map_err(|e| e.to_string())?;
    Ok(bytes.map(|b| data_url(&b, "image/jpeg")))
}

// ----- write commands (Fas 2) ---------------------------------------------

// ----- login / accounts (Fas 4) -------------------------------------------
//
// The interactive flows are event-driven: these commands kick off a step and
// progress is reported to the webview via tg:core-event `login` stages
// (code_sent / password_required / qr_code / complete).

#[tauri::command]
pub async fn tg_begin_code_login(
    state: State<'_, TelegramState>,
    phone: String,
) -> Result<(), String> {
    let core = state.core()?;
    core.accounts
        .begin_code_login(phone.trim())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn tg_submit_code(
    state: State<'_, TelegramState>,
    code: String,
) -> Result<(), String> {
    let core = state.core()?;
    core.accounts
        .submit_code(code.trim())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn tg_submit_password(
    state: State<'_, TelegramState>,
    password: String,
) -> Result<(), String> {
    let core = state.core()?;
    core.accounts
        .submit_password(&password)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn tg_begin_qr_login(state: State<'_, TelegramState>) -> Result<(), String> {
    let core = state.core()?;
    core.accounts.begin_qr_login().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn tg_sign_out(
    state: State<'_, TelegramState>,
    account_id: AccountId,
) -> Result<(), String> {
    let core = state.core()?;
    core.accounts
        .sign_out(account_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn tg_send_message(
    state: State<'_, TelegramState>,
    account_id: AccountId,
    chat_id: ChatId,
    text: String,
    reply_to: Option<MessageId>,
) -> Result<Message, String> {
    let core = state.core()?;
    core.send_message(account_id, chat_id, text, reply_to)
        .await
        .map_err(|e| e.to_string())
}

/// Send a file (image/video/etc.) with an optional caption. The bytes are
/// transferred efficiently over the IPC (Tauri passes typed arrays as raw
/// buffers), written to a temp file, uploaded, then removed.
#[tauri::command]
pub async fn tg_send_file(
    state: State<'_, TelegramState>,
    account_id: AccountId,
    chat_id: ChatId,
    file_name: String,
    bytes: Vec<u8>,
    caption: Option<String>,
) -> Result<Message, String> {
    let core = state.core()?;
    let dir = std::env::temp_dir().join("unified-inbox-upload");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let safe: String = file_name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') { c } else { '_' })
        .collect();
    let path = dir.join(if safe.is_empty() { "upload".to_owned() } else { safe });
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    let result = core
        .send_file(account_id, chat_id, &path, caption.as_deref().unwrap_or(""))
        .await
        .map_err(|e| e.to_string());
    let _ = std::fs::remove_file(&path);
    result
}

#[tauri::command]
pub async fn tg_edit_message(
    state: State<'_, TelegramState>,
    account_id: AccountId,
    chat_id: ChatId,
    message_id: MessageId,
    text: String,
) -> Result<(), String> {
    let core = state.core()?;
    core.edit_message(account_id, chat_id, message_id, &text)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn tg_delete_messages(
    state: State<'_, TelegramState>,
    account_id: AccountId,
    chat_id: ChatId,
    message_ids: Vec<MessageId>,
) -> Result<(), String> {
    let core = state.core()?;
    core.delete_messages(account_id, chat_id, message_ids)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn tg_react(
    state: State<'_, TelegramState>,
    account_id: AccountId,
    chat_id: ChatId,
    message_id: MessageId,
    emoji: Option<String>,
) -> Result<(), String> {
    let core = state.core()?;
    core.react(account_id, chat_id, message_id, emoji)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn tg_mark_read(
    state: State<'_, TelegramState>,
    account_id: AccountId,
    chat_id: ChatId,
) -> Result<(), String> {
    let core = state.core()?;
    core.mark_read(account_id, chat_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn tg_set_typing(
    state: State<'_, TelegramState>,
    account_id: AccountId,
    chat_id: ChatId,
) -> Result<(), String> {
    let core = state.core()?;
    core.set_typing(account_id, chat_id)
        .await
        .map_err(|e| e.to_string())
}

/// Directory for decrypted media temp files (streamed via the asset protocol).
fn media_tmp_dir() -> PathBuf {
    std::env::temp_dir().join("unified-inbox-media")
}

/// Best-effort clear of leftover decrypted media temp files (called on start).
pub fn clear_media_tmp() {
    let _ = std::fs::remove_dir_all(media_tmp_dir());
}

fn sanitize_name(name: &str) -> String {
    let safe: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') { c } else { '_' })
        .collect();
    if safe.is_empty() { "media.bin".to_owned() } else { safe }
}

/// Existing temp-file path for `name`, or `None`. Lets the frontend skip a
/// re-download when a media temp file is already on disk.
#[tauri::command]
pub fn media_temp_path(name: String) -> Option<String> {
    let path = media_tmp_dir().join(sanitize_name(&name));
    path.exists().then(|| path.to_string_lossy().into_owned())
}

/// Write bytes to a media temp file (served via the asset protocol) and return
/// its path. Used for iMessage attachments so a video streams from disk (range
/// requests) instead of living fully in the JS heap during playback.
#[tauri::command]
pub fn save_media_temp(bytes: Vec<u8>, name: String) -> Result<String, String> {
    let dir = media_tmp_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(sanitize_name(&name));
    if !path.exists() {
        std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    }
    Ok(path.to_string_lossy().into_owned())
}

/// Decrypt a media blob to a plaintext temp file and return its path, so the
/// frontend can stream it via `convertFileSrc` (the asset protocol supports
/// HTTP range requests — real seeking, no giant base64 data URL in memory).
/// Used for video; large files never enter the JS heap.
#[tauri::command]
pub async fn tg_media_file(
    state: State<'_, TelegramState>,
    account_id: AccountId,
    chat_id: ChatId,
    message_id: MessageId,
    cache_key: String,
    ext: Option<String>,
) -> Result<String, String> {
    let core = state.core()?;
    let dir = media_tmp_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let safe: String = cache_key
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    let ext = ext.unwrap_or_else(|| "bin".to_owned());
    let path = dir.join(format!("{safe}.{ext}"));
    if !path.exists() {
        let bytes = core
            .media_bytes(account_id, chat_id, message_id, &cache_key)
            .await
            .map_err(|e| e.to_string())?;
        std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    }
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn tg_media_data_url(
    state: State<'_, TelegramState>,
    account_id: AccountId,
    chat_id: ChatId,
    message_id: MessageId,
    cache_key: String,
    mime_type: Option<String>,
) -> Result<String, String> {
    let core = state.core()?;
    let bytes = core
        .media_bytes(account_id, chat_id, message_id, &cache_key)
        .await
        .map_err(|e| e.to_string())?;
    Ok(data_url(
        &bytes,
        mime_type.as_deref().unwrap_or("application/octet-stream"),
    ))
}
