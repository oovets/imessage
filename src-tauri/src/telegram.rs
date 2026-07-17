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
    let config = match AppConfig::load(dev_config_path().as_deref()) {
        Ok(config) => config,
        Err(e) => {
            log::warn!("telegram: config load failed, disabling: {e}");
            return TelegramState { core: None };
        }
    };
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
