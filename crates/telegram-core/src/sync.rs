//! Per-account background synchronization.
//!
//! One instance of [`run`] lives for each connected account. It:
//!
//! 1. announces `Connecting` → performs the initial dialog sync →
//!    `Synchronizing` → `UpToDate`;
//! 2. consumes the ordered update stream, persisting every fact to the
//!    database **before** broadcasting the matching [`CoreEvent`]
//!    (offline-first invariant);
//! 3. flushes the Keychain session snapshot periodically;
//! 4. reconnect-retries with exponential backoff, and fires `on_logged_out`
//!    if Telegram revokes the authorization.

use std::sync::Arc;
use std::time::Duration;

use database::Database;
use shared::model::{AccountId, SendState, SyncState};
use shared::{AppConfig, CoreEvent};
use telegram_api::{ApiEvent, TelegramClient};

use crate::bus::EventBus;

/// Entry point for the per-account sync task.
pub async fn run(
    account_id: AccountId,
    client: Arc<TelegramClient>,
    db: Database,
    bus: EventBus,
    config: AppConfig,
    on_logged_out: impl FnOnce() + Send + 'static,
) {
    let mut backoff = Duration::from_secs(config.sync.backoff_initial_secs.max(1));
    let backoff_max = Duration::from_secs(config.sync.backoff_max_secs.max(1));

    // The update stream can only be taken once per client; keep it across
    // reconnect attempts.
    bus.publish(CoreEvent::SyncStateChanged {
        account_id,
        state: SyncState::Connecting,
    });
    let mut stream = match client.take_update_stream(config.telegram.catch_up).await {
        Ok(stream) => stream,
        Err(e) => {
            tracing::error!(account_id, "cannot build update stream: {e}");
            return;
        }
    };

    loop {
        match sync_cycle(account_id, &client, &db, &bus, &config, &mut stream).await {
            CycleEnd::LoggedOut => {
                tracing::warn!(account_id, "authorization revoked");
                on_logged_out();
                return;
            }
            CycleEnd::Disconnected(reason) => {
                tracing::warn!(account_id, "sync interrupted: {reason}; retrying in {backoff:?}");
                bus.publish(CoreEvent::SyncStateChanged {
                    account_id,
                    state: SyncState::Offline,
                });
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(backoff_max);
            }
        }
    }
}

enum CycleEnd {
    Disconnected(String),
    LoggedOut,
}

async fn sync_cycle(
    account_id: AccountId,
    client: &TelegramClient,
    db: &Database,
    bus: &EventBus,
    config: &AppConfig,
    stream: &mut telegram_api::updates::EventStream,
) -> CycleEnd {
    // ---- initial sync: seed the chat list and previews -------------------
    bus.publish(CoreEvent::SyncStateChanged {
        account_id,
        state: SyncState::Synchronizing,
    });
    match client
        .list_dialogs(account_id, config.sync.dialogs_page_size)
        .await
    {
        Ok(entries) => {
            for entry in entries {
                if let Err(e) = db.chats().upsert(&entry.chat).await {
                    tracing::error!("failed to persist chat: {e}");
                    continue;
                }
                if let Some(message) = &entry.last_message {
                    if let Err(e) = db.messages().upsert(message).await {
                        tracing::error!("failed to persist last message: {e}");
                    }
                }
                bus.publish(CoreEvent::ChatUpdated { chat: entry.chat });
            }
        }
        Err(e) => {
            if e.is_auth_revoked() {
                return CycleEnd::LoggedOut;
            }
            return CycleEnd::Disconnected(e.to_string());
        }
    }
    if let Err(e) = client.session().flush() {
        tracing::warn!("session flush failed: {e}");
    }
    bus.publish(CoreEvent::SyncStateChanged {
        account_id,
        state: SyncState::UpToDate,
    });

    // ---- live updates -----------------------------------------------------
    let mut flush_timer = tokio::time::interval(Duration::from_secs(30));
    flush_timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            _ = flush_timer.tick() => {
                if let Err(e) = client.session().flush() {
                    tracing::warn!("periodic session flush failed: {e}");
                }
            }
            event = stream.next(account_id) => {
                match event {
                    Ok(event) => apply_event(account_id, db, bus, event).await,
                    Err(e) => {
                        if e.is_auth_revoked() {
                            return CycleEnd::LoggedOut;
                        }
                        stream.sync_state().await;
                        return CycleEnd::Disconnected(e.to_string());
                    }
                }
            }
        }
    }
}

/// Persist one mapped update and broadcast the resulting facts.
async fn apply_event(account_id: AccountId, db: &Database, bus: &EventBus, event: ApiEvent) {
    match event {
        ApiEvent::MessageNew(message) => {
            debug_assert_eq!(message.send_state, SendState::Sent);
            // Was this message already stored? On reconnect, catch-up
            // (getDifference) can re-deliver messages we've already seen and
            // read; without this guard each replay would re-increment the
            // unread count and resurrect "read" chats after a restart.
            let already_seen = db
                .messages()
                .get(account_id, message.chat_id, message.id)
                .await
                .ok()
                .flatten()
                .is_some();
            if let Err(e) = db.messages().upsert(&message).await {
                tracing::error!("persist new message failed: {e}");
                return;
            }
            let preview = if message.text.is_empty() {
                media_preview(&message)
            } else {
                message.text.clone()
            };
            let _ = db
                .chats()
                .touch_last_message(account_id, message.chat_id, message.date, &preview)
                .await;
            if !message.outgoing && !already_seen {
                if let Ok(Some(chat)) = db.chats().get(account_id, message.chat_id).await {
                    let _ = db
                        .chats()
                        .set_unread_count(account_id, message.chat_id, chat.unread_count + 1)
                        .await;
                }
            }
            if let Ok(Some(chat)) = db.chats().get(account_id, message.chat_id).await {
                bus.publish(CoreEvent::ChatUpdated { chat });
            }
            bus.publish(CoreEvent::MessageAdded { message });
        }
        ApiEvent::MessageEdited(message) => {
            if let Err(e) = db.messages().upsert(&message).await {
                tracing::error!("persist edited message failed: {e}");
                return;
            }
            bus.publish(CoreEvent::MessageUpdated { message });
        }
        ApiEvent::MessagesDeleted {
            channel_chat_id,
            message_ids,
        } => match channel_chat_id {
            Some(chat_id) => {
                if db
                    .messages()
                    .delete(account_id, chat_id, &message_ids)
                    .await
                    .is_ok()
                {
                    bus.publish(CoreEvent::MessageDeleted {
                        account_id,
                        chat_id,
                        message_ids,
                    });
                }
            }
            None => {
                // Ids are account-wide for non-channel chats; resolve the
                // affected chats from the database.
                if let Ok(deleted) = db
                    .messages()
                    .delete_by_ids_nonchannel(account_id, &message_ids)
                    .await
                {
                    let mut per_chat: std::collections::HashMap<i64, Vec<i32>> = Default::default();
                    for (chat_id, message_id) in deleted {
                        per_chat.entry(chat_id).or_default().push(message_id);
                    }
                    for (chat_id, message_ids) in per_chat {
                        bus.publish(CoreEvent::MessageDeleted {
                            account_id,
                            chat_id,
                            message_ids,
                        });
                    }
                }
            }
        },
        ApiEvent::Typing { chat_id, user_id } => {
            bus.publish(CoreEvent::Typing {
                account_id,
                chat_id,
                user_id,
            });
        }
        ApiEvent::Presence { user_id, presence } => {
            let _ = db
                .users()
                .set_presence(account_id, user_id, &presence)
                .await;
            bus.publish(CoreEvent::PresenceChanged {
                account_id,
                user_id,
                presence,
            });
        }
        ApiEvent::QrLoginAccepted | ApiEvent::Unhandled => {
            tracing::trace!("unhandled update kind");
        }
    }
}

fn media_preview(message: &shared::model::Message) -> String {
    match &message.media {
        Some(shared::model::Media::Photo { .. }) => "📷 Photo".to_owned(),
        Some(shared::model::Media::Sticker { emoji, .. }) => format!("{emoji} Sticker"),
        Some(shared::model::Media::Document { file_name, .. }) => format!("📎 {file_name}"),
        Some(shared::model::Media::Other { description }) => description.clone(),
        None => String::new(),
    }
}
