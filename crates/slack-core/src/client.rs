use anyhow::{anyhow, Result};
use futures_util::{SinkExt, StreamExt};
use reqwest::Client as HttpClient;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio_tungstenite::{connect_async, tungstenite::protocol::Message};
use tokio::sync::broadcast;

use crate::model::{ChatInfo, ChatSection};

/// Debug trace for the Slack client. The TUI wrote these to a file in /tmp;
/// inside the app they go through `tracing` like the rest of the backend.
fn log_debug(msg: &str) {
    tracing::debug!(target: "slack", "{msg}");
}

/// Updates received from Slack
#[derive(Debug, Clone, Serialize)]
pub enum SlackUpdate {
    NewMessage {
        channel_id: String,
        user_name: String,
        text: String,
        ts: String,
        thread_ts: Option<String>,
        is_bot: bool,
        is_self: bool,
        forwarded: Option<String>,
        mentions_me: bool,
        files: Vec<SlackFile>,
    },
    MessageChanged {
        channel_id: String,
        ts: String,
        new_text: String,
    },
    MessageDeleted {
        channel_id: String,
        ts: String,
    },
    UserTyping {
        channel_id: String,
        user_name: String,
    },
}

/// Fan-out for realtime updates.
///
/// The TUI drained `get_pending_updates()` from its render loop. The app needs
/// to *await* instead, so every update is also published on a broadcast channel
/// the host bridges to the webview — mirroring `telegram_core::Core::subscribe`.
#[derive(Clone)]
struct Updates {
    queued: Arc<Mutex<Vec<SlackUpdate>>>,
    tx: broadcast::Sender<SlackUpdate>,
}

impl Updates {
    fn new() -> Self {
        let (tx, _rx) = broadcast::channel(256);
        Self {
            queued: Arc::new(Mutex::new(Vec::new())),
            tx,
        }
    }

    async fn push(&self, update: SlackUpdate) {
        // Send first: a lagging subscriber must not block the queue.
        let _ = self.tx.send(update.clone());
        self.queued.lock().await.push(update);
    }

    async fn drain(&self) -> Vec<SlackUpdate> {
        std::mem::take(&mut *self.queued.lock().await)
    }
}

#[derive(Clone)]
pub struct SlackClient {
    http: HttpClient,
    token: String, // Can be either User Token (xoxp-) or Bot Token (xoxb-)
    user_id: Arc<Mutex<Option<String>>>,
    pending_updates: Updates,
    ws_handle: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
    ws_shutdown: Arc<Mutex<Option<broadcast::Sender<()>>>>,
    user_name_cache: Arc<Mutex<std::collections::HashMap<String, String>>>,
    user_info_cache: Arc<Mutex<std::collections::HashMap<String, CachedUserInfo>>>,
}

#[derive(Deserialize)]
#[allow(dead_code)]
struct AuthTestResponse {
    ok: bool,
    user_id: String,
    team: String,
    team_id: String,
}

#[derive(Deserialize)]
struct ConversationsListResponse {
    ok: bool,
    channels: Vec<Channel>,
    #[serde(default)]
    response_metadata: Option<ResponseMetadata>,
}

#[derive(Deserialize)]
struct Channel {
    id: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    user: Option<String>,
    #[serde(default)]
    is_group: bool,
    #[serde(default)]
    is_im: bool,
    #[serde(default)]
    is_mpim: bool,
    #[serde(default)]
    is_private: bool,
    #[serde(default)]
    is_archived: bool,
    #[serde(default)]
    #[allow(dead_code)]
    is_member: bool,
    #[serde(default)]
    is_shared: bool,
    #[serde(default)]
    is_ext_shared: bool,
    #[serde(default)]
    is_org_shared: bool,
    #[serde(default)]
    unread_count: Option<u32>,
}

#[derive(Deserialize)]
struct ConversationMembersResponse {
    ok: bool,
    #[serde(default)]
    members: Vec<String>,
}

#[derive(Deserialize)]
struct ConversationHistoryResponse {
    ok: bool,
    messages: Vec<SlackMessage>,
    #[serde(default)]
    response_metadata: Option<ResponseMetadata>,
}

#[derive(Deserialize)]
struct ResponseMetadata {
    #[serde(default)]
    next_cursor: String,
}

#[derive(Deserialize, Serialize, Clone)]
pub struct SlackReaction {
    pub name: String,
    pub count: u32,
}

#[derive(Deserialize, Serialize, Clone)]
pub struct SlackMessage {
    #[serde(rename = "type", default)]
    pub msg_type: String,
    pub ts: String,
    pub user: Option<String>,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub bot_id: Option<String>,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub app_id: Option<String>,
    #[serde(default)]
    pub bot_profile: Option<BotProfile>,
    #[serde(default)]
    pub reactions: Vec<SlackReaction>,
    #[serde(default)]
    pub thread_ts: Option<String>,
    #[serde(default)]
    pub reply_count: Option<u32>,
    #[serde(default)]
    pub attachments: Vec<SlackAttachment>,
    #[serde(default)]
    pub files: Vec<SlackFile>,
}

#[derive(Deserialize, Serialize, Clone)]
pub struct BotProfile {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub app_id: Option<String>,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct SlackFile {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub mimetype: Option<String>,
    #[serde(default)]
    pub filetype: Option<String>,
    #[serde(default)]
    pub url_private: Option<String>,
    #[serde(default)]
    pub url_private_download: Option<String>,
    #[serde(default)]
    pub thumb_64: Option<String>,
    #[serde(default)]
    pub thumb_360: Option<String>,
    #[serde(default)]
    pub thumb_480: Option<String>,
    #[serde(default)]
    pub thumb_720: Option<String>,
    #[serde(default)]
    pub thumb_800: Option<String>,
    #[serde(default)]
    pub thumb_960: Option<String>,
    #[serde(default)]
    pub thumb_1024: Option<String>,
    #[serde(default)]
    pub size: Option<u64>,
}

#[derive(Deserialize, Serialize, Clone)]
pub struct SlackAttachment {
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub fallback: Option<String>,
    #[serde(default)]
    pub pretext: Option<String>,
    #[serde(default)]
    pub author_name: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
}

fn extract_forwarded_text(attachments: &[SlackAttachment]) -> Option<String> {
    for att in attachments {
        if let Some(text) = att.text.as_ref().filter(|t| !t.is_empty()) {
            return Some(text.clone());
        }
        if let Some(pretext) = att.pretext.as_ref().filter(|t| !t.is_empty()) {
            return Some(pretext.clone());
        }
        if let Some(fallback) = att.fallback.as_ref().filter(|t| !t.is_empty()) {
            return Some(fallback.clone());
        }
    }
    None
}

/// Check if the text contains a mention of the specified user ID
/// Looks for patterns like <@U12345> or <@U12345|name>
fn text_mentions_user(text: &str, user_id: &str) -> bool {
    if user_id.is_empty() {
        return false;
    }
    
    // Look for <@USER_ID> or <@USER_ID|...>
    let pattern1 = format!("<@{}>", user_id);
    let pattern2 = format!("<@{}|", user_id);
    
    text.contains(&pattern1) || text.contains(&pattern2)
}

#[derive(Deserialize)]
struct UserInfoResponse {
    ok: bool,
    user: User,
}

#[derive(Deserialize)]
struct UserProfile {
    #[serde(default)]
    display_name: Option<String>,
}

#[derive(Deserialize)]
#[allow(dead_code)]
struct User {
    id: String,
    name: String,
    real_name: Option<String>,
    #[serde(default)]
    profile: Option<UserProfile>,
    #[serde(default)]
    is_bot: bool,
    #[serde(default)]
    deleted: bool,
}

#[derive(Clone)]
struct CachedUserInfo {
    name: String,
    is_bot: bool,
    deleted: bool,
}

#[derive(Deserialize)]
struct SocketModeConnectResponse {
    ok: bool,
    url: String,
}

impl SlackClient {
    pub async fn new(token: &str, _app_token: &str) -> Result<Self> {
        let http = HttpClient::new();
        let token = token.to_string();

        let client = Self {
            http,
            token,
            user_id: Arc::new(Mutex::new(None)),
            pending_updates: Updates::new(),
            ws_handle: Arc::new(Mutex::new(None)),
            ws_shutdown: Arc::new(Mutex::new(None)),
            user_name_cache: Arc::new(Mutex::new(std::collections::HashMap::new())),
            user_info_cache: Arc::new(Mutex::new(std::collections::HashMap::new())),
        };

        // Test authentication
        let auth_response: AuthTestResponse = client
            .http
            .get("https://slack.com/api/auth.test")
            .bearer_auth(&client.token)
            .send()
            .await?
            .json()
            .await?;

        if !auth_response.ok {
            return Err(anyhow!("Slack authentication failed"));
        }

        *client.user_id.lock().await = Some(auth_response.user_id);

        Ok(client)
    }

    pub async fn get_my_user_id(&self) -> Result<String> {
        let user_id = self.user_id.lock().await;
        user_id.clone().ok_or_else(|| anyhow!("User ID not set"))
    }

    pub async fn start_event_listener(&self, app_token: String) -> Result<()> {
        log_debug("start_event_listener called");
        
        let pending_updates = self.pending_updates.clone();
        let http = self.http.clone();
        let token = self.token.clone();
        let user_id = self.user_id.clone();
        let user_name_cache = self.user_name_cache.clone();
        let user_info_cache = self.user_info_cache.clone();
        let app_token = app_token.clone();

        // Create shutdown channel
        let (shutdown_tx, mut shutdown_rx) = broadcast::channel::<()>(1);
        *self.ws_shutdown.lock().await = Some(shutdown_tx);

        let handle = tokio::spawn(async move {

            log_debug("WebSocket task starting...");

            let mut backoff_secs: u64 = 1;

            'reconnect: loop {
                // Bail out early if shutdown was requested between reconnects
                if shutdown_rx.try_recv().is_ok() {
                    log_debug("Shutdown requested before reconnect, exiting");
                    break 'reconnect;
                }

                // Fetch a fresh socket URL on every (re)connect; URLs are single-use
                let url = match http
                    .post("https://slack.com/api/apps.connections.open")
                    .bearer_auth(&app_token)
                    .send()
                    .await
                {
                    Ok(resp) => match resp.json::<SocketModeConnectResponse>().await {
                        Ok(r) if r.ok => r.url,
                        Ok(_) => {
                            log_debug("apps.connections.open returned ok=false");
                            tokio::select! {
                                _ = tokio::time::sleep(std::time::Duration::from_secs(backoff_secs)) => {}
                                _ = shutdown_rx.recv() => break 'reconnect,
                            }
                            backoff_secs = (backoff_secs * 2).min(60);
                            continue;
                        }
                        Err(e) => {
                            log_debug(&format!("Failed to parse connect response: {}", e));
                            tokio::select! {
                                _ = tokio::time::sleep(std::time::Duration::from_secs(backoff_secs)) => {}
                                _ = shutdown_rx.recv() => break 'reconnect,
                            }
                            backoff_secs = (backoff_secs * 2).min(60);
                            continue;
                        }
                    },
                    Err(e) => {
                        log_debug(&format!("apps.connections.open request failed: {}", e));
                        tokio::select! {
                            _ = tokio::time::sleep(std::time::Duration::from_secs(backoff_secs)) => {}
                            _ = shutdown_rx.recv() => break 'reconnect,
                        }
                        backoff_secs = (backoff_secs * 2).min(60);
                        continue;
                    }
                };

                let mut ws_stream = match connect_async(&url).await {
                    Ok((s, _)) => {
                        log_debug("WebSocket connected successfully");
                        backoff_secs = 1;
                        s
                    }
                    Err(e) => {
                        log_debug(&format!("Failed to connect WebSocket: {}", e));
                        tokio::select! {
                            _ = tokio::time::sleep(std::time::Duration::from_secs(backoff_secs)) => {}
                            _ = shutdown_rx.recv() => break 'reconnect,
                        }
                        backoff_secs = (backoff_secs * 2).min(60);
                        continue;
                    }
                };

                loop {
                    tokio::select! {
                        next = ws_stream.next() => {
                            match next {
                                Some(Ok(Message::Text(text))) => {
                                    log_debug(&format!("Received WebSocket message: {}", &text[..text.len().min(200)]));
                                    if let Ok(envelope) = serde_json::from_str::<serde_json::Value>(&text) {
                                        let env_type = envelope.get("type").and_then(|v| v.as_str()).unwrap_or("");

                                        // Slack periodically tells the client to reconnect (refresh / warning)
                                        if env_type == "disconnect" {
                                            log_debug("Received disconnect from Slack, reconnecting");
                                            let _ = ws_stream.close(None).await;
                                            break;
                                        }

                                        // Acknowledge envelope
                                        if let Some(envelope_id) =
                                            envelope.get("envelope_id").and_then(|v| v.as_str())
                                        {
                                            let ack = serde_json::json!({
                                                "envelope_id": envelope_id
                                            });
                                            if let Err(e) = ws_stream.send(Message::text(ack.to_string())).await {
                                                log_debug(&format!(
                                                    "Failed to acknowledge envelope {}, reconnecting: {}",
                                                    envelope_id, e
                                                ));
                                                break;
                                            }
                                            log_debug(&format!("Acknowledged envelope: {}", envelope_id));
                                        }

                                        log_debug(&format!("Event type: {}", env_type));
                                        if env_type == "events_api" {
                                            if let Some(event) =
                                                envelope.get("payload").and_then(|p| p.get("event"))
                                            {
                                                let event_owned = event.clone();
                                                let pending_updates = pending_updates.clone();
                                                let http = http.clone();
                                                let token = token.clone();
                                                let user_id = user_id.clone();
                                                let user_name_cache = user_name_cache.clone();
                                                let user_info_cache = user_info_cache.clone();

                                                tokio::spawn(async move {
                                                    log_debug(&format!("Processing event: {:?}", event_owned));
                                                    Self::process_event(
                                                        &event_owned,
                                                        &pending_updates,
                                                        &http,
                                                        &token,
                                                        &user_id,
                                                        &user_name_cache,
                                                        &user_info_cache,
                                                    )
                                                    .await;
                                                    log_debug("Event processed, added to pending_updates");
                                                });
                                            }
                                        }
                                    }
                                }
                                Some(Ok(Message::Ping(p))) => {
                                    let _ = ws_stream.send(Message::Pong(p)).await;
                                }
                                Some(Ok(Message::Close(frame))) => {
                                    log_debug(&format!("WebSocket closed by server: {:?}, reconnecting", frame));
                                    break;
                                }
                                Some(Ok(_)) => {
                                    // Pong/Binary/Frame: ignore
                                }
                                Some(Err(e)) => {
                                    log_debug(&format!("WebSocket error: {}, reconnecting", e));
                                    break;
                                }
                                None => {
                                    log_debug("WebSocket stream ended, reconnecting");
                                    break;
                                }
                            }
                        }
                        _ = shutdown_rx.recv() => {
                            log_debug("Received shutdown signal, closing WebSocket gracefully");
                            let _ = ws_stream.close(None).await;
                            log_debug("WebSocket closed");
                            break 'reconnect;
                        }
                    }
                }
            }
            log_debug("WebSocket task exiting");
        });

        *self.ws_handle.lock().await = Some(handle);
        Ok(())
    }

    async fn process_event(
        event: &serde_json::Value,
        pending_updates: &Updates,
        http: &HttpClient,
        token: &str,
        user_id: &Arc<Mutex<Option<String>>>,
        user_name_cache: &Arc<Mutex<std::collections::HashMap<String, String>>>,
        user_info_cache: &Arc<Mutex<std::collections::HashMap<String, CachedUserInfo>>>,
    ) {
        if let Some(event_type) = event.get("type").and_then(|v| v.as_str()) {
            match event_type {
                "message" => {
                    // Check for message subtypes (edited, deleted)
                    let subtype = event.get("subtype").and_then(|v| v.as_str());
                    
                    match subtype {
                        Some("message_changed") => {
                            // Message was edited
                            if let (Some(channel_id), Some(message)) = (
                                event.get("channel").and_then(|v| v.as_str()),
                                event.get("message"),
                            ) {
                                if let (Some(ts), Some(new_text)) = (
                                    message.get("ts").and_then(|v| v.as_str()),
                                    message.get("text").and_then(|v| v.as_str()),
                                ) {
                                    pending_updates.push(SlackUpdate::MessageChanged {
                                        channel_id: channel_id.to_string(),
                                        ts: ts.to_string(),
                                        new_text: new_text.to_string(),
                                    }).await;
                                }
                            }
                            return;
                        }
                        Some("message_deleted") => {
                            // Message was deleted
                            if let (Some(channel_id), Some(deleted_ts)) = (
                                event.get("channel").and_then(|v| v.as_str()),
                                event.get("deleted_ts").and_then(|v| v.as_str()),
                            ) {
                                pending_updates.push(SlackUpdate::MessageDeleted {
                                    channel_id: channel_id.to_string(),
                                    ts: deleted_ts.to_string(),
                                }).await;
                            }
                            return;
                        }
                        _ => {}
                    }
                    
                    // Regular new message
                    if let (Some(channel_id), Some(text), Some(ts)) = (
                        event.get("channel").and_then(|v| v.as_str()),
                        event.get("text").and_then(|v| v.as_str()),
                        event.get("ts").and_then(|v| v.as_str()),
                    ) {
                        let user_id_event = event
                            .get("user")
                            .and_then(|v| v.as_str())
                            .unwrap_or("unknown");
                        let is_bot = event.get("bot_id").is_some();
                        let thread_ts = event
                            .get("thread_ts")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string());
                        let attachments: Vec<SlackAttachment> = event
                            .get("attachments")
                            .and_then(|a| serde_json::from_value(a.clone()).ok())
                            .unwrap_or_default();
                        let forwarded = extract_forwarded_text(&attachments);

                        let my_id = user_id.lock().await.clone().unwrap_or_default();
                        let is_self = !my_id.is_empty() && user_id_event == my_id;
                        
                        // Check if the message mentions the current user
                        let mentions_me = !my_id.is_empty() && text_mentions_user(text, &my_id);

                        // Fetch user name - prioritize user field first (real users), then bot_profile, username, bot_id
                        let user_name = if event.get("user").is_some() && user_id_event != "unknown" {
                            // Regular user - prefer cache to avoid HTTP on every event
                            if let Some(info) = user_info_cache.lock().await.get(user_id_event).cloned() {
                                info.name
                            } else {
                                if let Ok(user_info) = Self::fetch_user_info(http, token, user_id_event).await {
                                    user_name_cache
                                        .lock()
                                        .await
                                        .insert(user_id_event.to_string(), user_info.clone());
                                    user_info_cache.lock().await.insert(
                                        user_id_event.to_string(),
                                        CachedUserInfo {
                                            name: user_info.clone(),
                                            is_bot: false,
                                            deleted: false,
                                        },
                                    );
                                    user_info
                                } else {
                                    user_id_event.to_string()
                                }
                            }
                        } else if let Some(bot_profile) = event.get("bot_profile") {
                            // Slack app/webhook with bot_profile (only if no user field)
                            let name = bot_profile
                                .get("name")
                                .and_then(|n| n.as_str())
                                .unwrap_or("Bot")
                                .to_string();
                            name
                        } else if let Some(username) = event.get("username").and_then(|u| u.as_str()) {
                            // Bot with username field
                            username.to_string()
                        } else if let Some(bot_id) = event.get("bot_id").and_then(|b| b.as_str()) {
                            // Bot message - fetch bot info
                            let client = SlackClient {
                                http: http.clone(),
                                token: token.to_string(),
                                user_id: user_id.clone(),
                                pending_updates: pending_updates.clone(),
                                ws_handle: Arc::new(Mutex::new(None)),
                                ws_shutdown: Arc::new(Mutex::new(None)),
                                user_name_cache: Arc::new(Mutex::new(std::collections::HashMap::new())),
                                user_info_cache: Arc::new(Mutex::new(std::collections::HashMap::new())),
                            };
                            client.resolve_bot_name(bot_id).await
                        } else {
                            user_id_event.to_string()
                        };

                        // Extract files from event
                        let files: Vec<SlackFile> = event
                            .get("files")
                            .and_then(|f| serde_json::from_value(f.clone()).ok())
                            .unwrap_or_default();

                        pending_updates.push(SlackUpdate::NewMessage {
                            channel_id: channel_id.to_string(),
                            user_name,
                            text: text.to_string(),
                            ts: ts.to_string(),
                            thread_ts,
                            is_bot,
                            is_self,
                            forwarded,
                            mentions_me,
                            files,
                        }).await;
                    }
                }
                "user_typing" => {
                    if let (Some(channel_id), Some(user_id)) = (
                        event.get("channel").and_then(|v| v.as_str()),
                        event.get("user").and_then(|v| v.as_str()),
                    ) {
                        let user_name = if let Ok(user_info) =
                            Self::fetch_user_info(http, token, user_id).await
                        {
                            user_info
                        } else {
                            user_id.to_string()
                        };

                        pending_updates.push(SlackUpdate::UserTyping {
                            channel_id: channel_id.to_string(),
                            user_name,
                        }).await;
                    }
                }
                _ => {}
            }
        }
    }

    pub async fn resolve_user_name(&self, user_id: &str) -> String {
        // Check cache first
        {
            let cache = self.user_name_cache.lock().await;
            if let Some(name) = cache.get(user_id) {
                return name.clone();
            }
        }

        self.fetch_user_info_cached(user_id)
            .await
            .map(|info| info.name)
            .unwrap_or_else(|| user_id.to_string())
    }

    /// Get a snapshot of the user name cache for synchronous lookups.
    pub async fn get_user_name_cache(&self) -> std::collections::HashMap<String, String> {
        self.user_name_cache.lock().await.clone()
    }

    /// Best human name for a user: the @nickname they chose, else their real
    /// name, else the handle. Never the raw id — that is only reachable when
    /// the API call itself fails.
    fn display_name_for_user(user: &User) -> String {
        user.profile
            .as_ref()
            .and_then(|p| p.display_name.as_ref())
            .filter(|n| !n.is_empty())
            .or(user.real_name.as_ref().filter(|n| !n.is_empty()))
            .cloned()
            .unwrap_or_else(|| user.name.clone())
    }

    async fn fetch_user_info(http: &HttpClient, token: &str, user_id: &str) -> Result<String> {
        let response: UserInfoResponse = http
            .get(&format!(
                "https://slack.com/api/users.info?user={}",
                user_id
            ))
            .bearer_auth(token)
            .send()
            .await?
            .json()
            .await?;

        if response.ok {
            Ok(Self::display_name_for_user(&response.user))
        } else {
            Ok(user_id.to_string())
        }
    }

    async fn fetch_user_info_cached(&self, user_id: &str) -> Option<CachedUserInfo> {
        {
            let cache = self.user_info_cache.lock().await;
            if let Some(info) = cache.get(user_id) {
                return Some(info.clone());
            }
        }

        let response: UserInfoResponse = self
            .http
            .get(&format!(
                "https://slack.com/api/users.info?user={}",
                user_id
            ))
            .bearer_auth(&self.token)
            .send()
            .await
            .ok()?
            .json()
            .await
            .ok()?;

        if !response.ok {
            return None;
        }

        let info = CachedUserInfo {
            name: Self::display_name_for_user(&response.user),
            is_bot: response.user.is_bot,
            deleted: response.user.deleted,
        };

        self.user_info_cache
            .lock()
            .await
            .insert(user_id.to_string(), info.clone());
        self.user_name_cache
            .lock()
            .await
            .insert(user_id.to_string(), info.name.clone());
        Some(info)
    }

    async fn prefetch_user_infos(&self, user_ids: Vec<String>) {
        let user_ids: std::collections::HashSet<String> = user_ids.into_iter().collect();
        let missing: Vec<String> = {
            let cache = self.user_info_cache.lock().await;
            user_ids
                .into_iter()
                .filter(|user_id| !cache.contains_key(user_id))
                .collect()
        };

        futures_util::stream::iter(missing)
            .for_each_concurrent(16, |user_id| {
                let slack = self.clone();
                async move {
                    let _ = slack.fetch_user_info_cached(&user_id).await;
                }
            })
            .await;
    }

    pub async fn resolve_bot_name(&self, bot_id: &str) -> String {
        // Check cache first
        {
            let cache = self.user_name_cache.lock().await;
            if let Some(name) = cache.get(bot_id) {
                return name.clone();
            }
        }
        
        // Fetch bot info
        let resp = self
            .http
            .get(&format!(
                "https://slack.com/api/bots.info?bot={}",
                bot_id
            ))
            .bearer_auth(&self.token)
            .send()
            .await;

        if let Ok(resp) = resp {
            if let Ok(json) = resp.json::<serde_json::Value>().await {
                if json.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
                    if let Some(name) = json.get("bot")
                        .and_then(|b| b.get("name"))
                        .and_then(|n| n.as_str()) {
                        let name_str = name.to_string();
                        // Cache it
                        self.user_name_cache
                            .lock()
                            .await
                            .insert(bot_id.to_string(), name_str.clone());
                        return name_str;
                    }
                }
            }
        }
        
        bot_id.to_string()
    }

    pub async fn get_conversation_members(&self, channel_id: &str) -> Result<Vec<String>> {
        let response: ConversationMembersResponse = self
            .http
            .get(&format!(
                "https://slack.com/api/conversations.members?channel={}&limit=100",
                channel_id
            ))
            .bearer_auth(&self.token)
            .send()
            .await?
            .json()
            .await?;

        if !response.ok {
            return Err(anyhow!("Failed to fetch conversation members"));
        }

        Ok(response.members)
    }

    pub async fn get_conversations(&self) -> Result<Vec<ChatInfo>> {
        // Use users.conversations which returns everything the current user has
        // access to (public, private, shared, mpim, im) across paginated results.
        let mut all_channels: Vec<Channel> = Vec::new();
        let mut cursor: Option<String> = None;
        loop {
            let mut url = String::from(
                "https://slack.com/api/users.conversations?types=public_channel,private_channel,mpim,im&limit=200&exclude_archived=true",
            );
            if let Some(ref c) = cursor {
                url.push_str(&format!("&cursor={}", c));
            }

            let response: ConversationsListResponse = self
                .http
                .get(&url)
                .bearer_auth(&self.token)
                .send()
                .await?
                .json()
                .await?;

            if !response.ok {
                return Err(anyhow!("Failed to fetch conversations"));
            }

            all_channels.extend(response.channels);

            match response.response_metadata.and_then(|m| {
                if m.next_cursor.trim().is_empty() {
                    None
                } else {
                    Some(m.next_cursor)
                }
            }) {
                Some(c) => cursor = Some(c),
                None => break,
            }
        }

        let my_user_id = self.get_my_user_id().await.unwrap_or_default();
        let dm_user_ids = all_channels
            .iter()
            .filter(|ch| ch.is_im)
            .filter_map(|ch| ch.user.clone())
            .collect();
        self.prefetch_user_infos(dm_user_ids).await;

        let mut chats = Vec::new();
        for ch in all_channels {
            if ch.is_archived {
                continue;
            }

            let dm_user_info = if ch.is_im {
                if let Some(ref uid) = ch.user {
                    self.fetch_user_info_cached(uid).await
                } else {
                    None
                }
            } else {
                None
            };
            
            // Skip DMs with deleted users
            if dm_user_info
                .as_ref()
                .map(|info| info.deleted)
                .unwrap_or(false)
            {
                continue;
            }

            // Determine section
            let section = if ch.is_mpim {
                ChatSection::Group
            } else if ch.is_im {
                if dm_user_info
                    .as_ref()
                    .map(|info| info.is_bot)
                    .unwrap_or(false)
                {
                    ChatSection::Bot
                } else {
                    ChatSection::DirectMessage
                }
            } else if ch.is_ext_shared || ch.is_shared || ch.is_org_shared {
                ChatSection::Shared
            } else if ch.is_private || ch.is_group {
                ChatSection::Private
            } else {
                ChatSection::Public
            };

            let name = match section {
                ChatSection::Group => {
                    // Fetch members and build "Name1, Name2" excluding self
                    match self.get_conversation_members(&ch.id).await {
                        Ok(members) => {
                            let members: Vec<String> = members
                                .into_iter()
                                .filter(|mid| mid != &my_user_id)
                                .collect();
                            self.prefetch_user_infos(members.clone()).await;

                            let mut names = Vec::new();
                            for mid in &members {
                                let n = self.resolve_user_name(mid).await;
                                // Use first name only
                                let first =
                                    n.split_whitespace().next().unwrap_or(&n).to_string();
                                names.push(first);
                            }
                            if names.is_empty() {
                                ch.name.unwrap_or_else(|| ch.id.clone())
                            } else {
                                names.join(", ")
                            }
                        }
                        Err(_) => ch.name.unwrap_or_else(|| ch.id.clone()),
                    }
                }
                ChatSection::DirectMessage | ChatSection::Bot => {
                    if let Some(info) = dm_user_info {
                        info.name
                    } else if let Some(ref user_id) = ch.user {
                        self.resolve_user_name(user_id).await
                    } else {
                        ch.name.unwrap_or_else(|| ch.id.clone())
                    }
                }
                _ => ch.name.unwrap_or_else(|| ch.id.clone()),
            };

            chats.push(ChatInfo {
                id: ch.id.clone(),
                name,
                username: ch.user.or(Some(ch.id)),
                unread: ch.unread_count.unwrap_or(0),
                section,
            });
        }

        Ok(chats)
    }

    pub async fn get_conversation_history(
        &self,
        channel_id: &str,
        limit: usize,
    ) -> Result<Vec<SlackMessage>> {
        let mut all_messages: Vec<SlackMessage> = Vec::new();
        let mut cursor: Option<String> = None;
        let page_limit = limit.min(200).max(1);

        loop {
            let mut url = format!(
                "https://slack.com/api/conversations.history?channel={}&limit={}",
                channel_id, page_limit
            );
            if let Some(ref c) = cursor {
                url.push_str(&format!("&cursor={}", c));
            }

            let response: ConversationHistoryResponse = self
                .http
                .get(&url)
                .bearer_auth(&self.token)
                .send()
                .await?
                .json()
                .await?;

            if !response.ok {
                return Err(anyhow!("Failed to fetch conversation history"));
            }

            all_messages.extend(response.messages);
            if all_messages.len() >= limit {
                all_messages.truncate(limit);
                break;
            }

            let next_cursor = response
                .response_metadata
                .and_then(|m| {
                    if m.next_cursor.trim().is_empty() {
                        None
                    } else {
                        Some(m.next_cursor)
                    }
                });

            match next_cursor {
                Some(c) => cursor = Some(c),
                None => break,
            }
        }

        self.fill_user_names(&mut all_messages).await;
        Ok(all_messages)
    }

    /// Put a human name on every message.
    ///
    /// `conversations.history` identifies authors only by id (`U08846VMHT5`),
    /// while realtime updates carry a name — so without this, loaded history
    /// renders as raw ids while new messages in the same channel show names.
    /// Ids are resolved in one batch through the shared cache.
    async fn fill_user_names(&self, messages: &mut [SlackMessage]) {
        let ids: Vec<String> = messages
            .iter()
            .filter(|m| m.username.is_none())
            .filter_map(|m| m.user.clone())
            .collect();
        if ids.is_empty() {
            return;
        }
        self.prefetch_user_infos(ids).await;
        for message in messages.iter_mut() {
            if message.username.is_some() {
                continue;
            }
            if let Some(ref user_id) = message.user {
                message.username = Some(self.resolve_user_name(user_id).await);
            }
        }
    }

    /// Fetch a file's bytes with the workspace token.
    ///
    /// Slack's `url_private` links are not public: without the bearer token
    /// they return an HTML sign-in page, which is why attachments rendered as
    /// broken images. The webview has no token, so the fetch happens here.
    pub async fn fetch_file_bytes(&self, url: &str) -> Result<Vec<u8>> {
        let response = self
            .http
            .get(url)
            .bearer_auth(&self.token)
            .send()
            .await?
            .error_for_status()?;

        // A token that lacks `files:read` gets redirected to the login page
        // with a 200, so trust the content type rather than the status.
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        if content_type.starts_with("text/html") {
            return Err(anyhow!(
                "Slack returned a sign-in page for this file — the workspace token is missing the files:read scope"
            ));
        }

        Ok(response.bytes().await?.to_vec())
    }

    pub async fn get_thread_replies(
        &self,
        channel_id: &str,
        thread_ts: &str,
        limit: usize,
    ) -> Result<Vec<SlackMessage>> {
        let mut all_messages: Vec<SlackMessage> = Vec::new();
        let mut cursor: Option<String> = None;
        let page_limit = limit.min(200).max(1);

        loop {
            let mut url = format!(
                "https://slack.com/api/conversations.replies?channel={}&ts={}&limit={}",
                channel_id, thread_ts, page_limit
            );
            if let Some(ref c) = cursor {
                url.push_str(&format!("&cursor={}", c));
            }

            let response: ConversationHistoryResponse = self
                .http
                .get(&url)
                .bearer_auth(&self.token)
                .send()
                .await?
                .json()
                .await?;

            if !response.ok {
                return Err(anyhow!("Failed to fetch thread replies"));
            }

            all_messages.extend(response.messages);
            if all_messages.len() >= limit {
                all_messages.truncate(limit);
                break;
            }

            let next_cursor = response
                .response_metadata
                .and_then(|m| {
                    if m.next_cursor.trim().is_empty() {
                        None
                    } else {
                        Some(m.next_cursor)
                    }
                });

            match next_cursor {
                Some(c) => cursor = Some(c),
                None => break,
            }
        }

        Ok(all_messages)
    }

    pub async fn send_message(
        &self,
        channel_id: &str,
        text: &str,
        thread_ts: Option<&str>,
    ) -> Result<()> {
        let mut payload = serde_json::json!({
            "channel": channel_id,
            "text": text,
        });
        if let Some(ts) = thread_ts {
            payload["thread_ts"] = serde_json::Value::String(ts.to_string());
        }

        let response: serde_json::Value = self
            .http
            .post("https://slack.com/api/chat.postMessage")
            .bearer_auth(&self.token)
            .json(&payload)
            .send()
            .await?
            .json()
            .await?;

        if !response
            .get("ok")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
        {
            return Err(anyhow!("Failed to send message"));
        }

        Ok(())
    }

    pub async fn add_reaction(&self, channel_id: &str, timestamp: &str, emoji: &str) -> Result<()> {
        let payload = serde_json::json!({
            "channel": channel_id,
            "timestamp": timestamp,
            "name": emoji,
        });

        let response: serde_json::Value = self
            .http
            .post("https://slack.com/api/reactions.add")
            .bearer_auth(&self.token)
            .json(&payload)
            .send()
            .await?
            .json()
            .await?;

        if !response
            .get("ok")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
        {
            return Err(anyhow!("Failed to add reaction"));
        }

        Ok(())
    }

    pub async fn leave_conversation(&self, channel_id: &str) -> Result<()> {
        let payload = serde_json::json!({
            "channel": channel_id,
        });

        let response: serde_json::Value = self
            .http
            .post("https://slack.com/api/conversations.leave")
            .bearer_auth(&self.token)
            .json(&payload)
            .send()
            .await?
            .json()
            .await?;

        if !response
            .get("ok")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
        {
            return Err(anyhow!("Failed to leave conversation"));
        }

        Ok(())
    }

    /// Subscribe to realtime updates. The host bridges this straight to the
    /// webview; late subscribers only see updates from the moment they attach.
    /// This workspace's own user id, once authenticated.
    ///
    /// Realtime updates carry `is_self`, but `conversations.history` only
    /// reports each message's author, so the caller needs the id to tell which
    /// history messages are its own.
    pub async fn self_user_id(&self) -> Option<String> {
        self.user_id.lock().await.clone()
    }

    pub fn subscribe(&self) -> broadcast::Receiver<SlackUpdate> {
        self.pending_updates.tx.subscribe()
    }

    pub async fn get_pending_updates(&self) -> Vec<SlackUpdate> {
        self.pending_updates.drain().await
    }

    /// Gracefully shutdown the background WebSocket task.
    pub async fn shutdown(&self) {
        log_debug("shutdown() called");
        
        // Send shutdown signal to gracefully close WebSocket
        if let Some(tx) = self.ws_shutdown.lock().await.take() {
            let _ = tx.send(());
        log_debug("Shutdown signal sent");
        }
        
        // Wait for the task to finish (with timeout)
        if let Some(handle) = self.ws_handle.lock().await.take() {
            let _ = tokio::time::timeout(std::time::Duration::from_secs(2), handle).await;
        log_debug("WebSocket task finished");
        }
    }
}
