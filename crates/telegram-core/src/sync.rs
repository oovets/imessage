//! Per-account background synchronization.
//!
//! One instance of [`run`] lives for each connected account. It:
//!
//! 1. announces `Connecting` → performs the initial dialog sync (the
//!    account's notification defaults, then the dialogs) →
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
    // Notification defaults first: chats without a mute of their own follow
    // them. One fetch per sync, not per dialog; if it fails, the last known
    // defaults still resolve the chat list.
    let defaults = match client.mute_defaults().await {
        Ok(defaults) => {
            if let Err(e) = db.chats().set_mute_defaults(account_id, &defaults).await {
                tracing::error!("failed to persist mute defaults: {e}");
            }
            defaults
        }
        Err(e) => {
            if e.is_auth_revoked() {
                return CycleEnd::LoggedOut;
            }
            tracing::warn!(account_id, "mute defaults unavailable, using stored: {e}");
            db.chats()
                .mute_defaults(account_id)
                .await
                .unwrap_or_default()
        }
    };
    match client
        .list_dialogs(account_id, config.sync.dialogs_page_size, &defaults)
        .await
    {
        Ok(entries) => {
            for entry in entries {
                if let Err(e) = db.chats().upsert(&entry.chat).await {
                    tracing::error!("failed to persist chat: {e}");
                    continue;
                }
                if let Err(e) = db
                    .chats()
                    .set_mute_until(account_id, entry.chat.id, entry.mute_until)
                    .await
                {
                    tracing::error!("failed to persist chat mute: {e}");
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
        ApiEvent::ChatMuteChanged {
            chat_id,
            mute_until,
        } => {
            if let Err(e) = db
                .chats()
                .set_mute_until(account_id, chat_id, mute_until)
                .await
            {
                tracing::error!("persist chat mute failed: {e}");
                return;
            }
            // Unknown chats (not in the synced dialog page) have no row.
            if let Ok(Some(chat)) = db.chats().get(account_id, chat_id).await {
                bus.publish(CoreEvent::ChatUpdated { chat });
            }
        }
        ApiEvent::MuteDefaultChanged { kind, mute_until } => {
            if let Err(e) = db
                .chats()
                .set_mute_default(account_id, kind, mute_until)
                .await
            {
                tracing::error!("persist mute default failed: {e}");
                return;
            }
            // Only chats without a mute of their own follow the default.
            match db
                .chats()
                .list_following_mute_default(account_id, kind)
                .await
            {
                Ok(chats) => {
                    for chat in chats {
                        bus.publish(CoreEvent::ChatUpdated { chat });
                    }
                }
                Err(e) => tracing::error!("reload chats after mute default change failed: {e}"),
            }
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

#[cfg(test)]
mod tests {
    use super::*;
    use shared::model::{Account, Chat, ChatId, ChatKind, Message};
    use tokio::sync::broadcast::error::TryRecvError;

    async fn db_with_chats(chats: &[(ChatId, ChatKind)]) -> Database {
        let db = Database::open_in_memory().await.expect("open");
        db.accounts()
            .upsert(&Account {
                id: 1,
                phone: None,
                first_name: "t".into(),
                last_name: None,
                username: None,
                authorized: true,
            })
            .await
            .expect("account");
        for &(id, kind) in chats {
            db.chats()
                .upsert(&Chat {
                    account_id: 1,
                    id,
                    kind,
                    title: format!("chat {id}"),
                    username: None,
                    unread_count: 0,
                    pinned: false,
                    last_message_at: None,
                    last_message_preview: None,
                    avatar_key: None,
                    muted_until: None,
                })
                .await
                .expect("chat");
        }
        db
    }

    fn forever() -> Option<chrono::DateTime<chrono::Utc>> {
        chrono::DateTime::from_timestamp(i64::from(i32::MAX), 0)
    }

    /// Every ChatUpdated published so far, in order.
    fn published_chats(rx: &mut tokio::sync::broadcast::Receiver<CoreEvent>) -> Vec<Chat> {
        let mut chats = Vec::new();
        loop {
            match rx.try_recv() {
                Ok(CoreEvent::ChatUpdated { chat }) => chats.push(chat),
                Ok(_) => {}
                Err(TryRecvError::Empty) => return chats,
                Err(e) => panic!("bus: {e}"),
            }
        }
    }

    #[tokio::test]
    async fn chat_mute_change_persists_and_republishes() {
        let db = db_with_chats(&[(10, ChatKind::Private)]).await;
        let bus = EventBus::new();
        let mut rx = bus.subscribe();

        let mute = |mute_until| ApiEvent::ChatMuteChanged {
            chat_id: 10,
            mute_until,
        };
        apply_event(1, &db, &bus, mute(Some(i32::MAX))).await;
        let published = published_chats(&mut rx);
        assert_eq!(published.len(), 1);
        assert_eq!(published[0].muted_until, forever());
        assert_eq!(
            db.chats()
                .get(1, 10)
                .await
                .expect("get")
                .expect("some")
                .muted_until,
            forever()
        );

        apply_event(1, &db, &bus, mute(Some(0))).await;
        let published = published_chats(&mut rx);
        assert_eq!(published.len(), 1);
        assert_eq!(published[0].muted_until, None);
    }

    #[tokio::test]
    async fn mute_change_for_an_unknown_chat_publishes_nothing() {
        let db = db_with_chats(&[]).await;
        let bus = EventBus::new();
        let mut rx = bus.subscribe();
        apply_event(
            1,
            &db,
            &bus,
            ApiEvent::ChatMuteChanged {
                chat_id: 99,
                mute_until: Some(i32::MAX),
            },
        )
        .await;
        assert!(published_chats(&mut rx).is_empty());
    }

    #[tokio::test]
    async fn default_change_republishes_only_the_chats_that_follow_it() {
        let db = db_with_chats(&[
            (1, ChatKind::Private),
            (2, ChatKind::Private),
            (3, ChatKind::Group),
        ])
        .await;
        // Chat 2 was unmuted on its own, so the private default skips it.
        db.chats()
            .set_mute_until(1, 2, Some(0))
            .await
            .expect("mute");
        let bus = EventBus::new();
        let mut rx = bus.subscribe();

        apply_event(
            1,
            &db,
            &bus,
            ApiEvent::MuteDefaultChanged {
                kind: ChatKind::Private,
                mute_until: Some(i32::MAX),
            },
        )
        .await;

        let published = published_chats(&mut rx);
        assert_eq!(published.iter().map(|c| c.id).collect::<Vec<_>>(), vec![1]);
        assert_eq!(published[0].muted_until, forever());
        assert_eq!(
            db.chats().mute_defaults(1).await.expect("defaults").private,
            Some(i32::MAX)
        );
        assert_eq!(
            db.chats()
                .get(1, 2)
                .await
                .expect("get")
                .expect("some")
                .muted_until,
            None
        );
        assert_eq!(
            db.chats()
                .get(1, 3)
                .await
                .expect("get")
                .expect("some")
                .muted_until,
            None
        );
    }

    #[tokio::test]
    async fn new_message_in_a_muted_chat_still_counts_as_unread() {
        let db = db_with_chats(&[(10, ChatKind::Private)]).await;
        db.chats()
            .set_mute_until(1, 10, Some(i32::MAX))
            .await
            .expect("mute");
        let bus = EventBus::new();
        let mut rx = bus.subscribe();

        let message = Message {
            account_id: 1,
            chat_id: 10,
            id: 1,
            sender_id: Some(10),
            sender_name: None,
            text: "hej".into(),
            media: None,
            reactions: Vec::new(),
            reply_to: None,
            date: chrono::Utc::now(),
            edited: false,
            outgoing: false,
            send_state: SendState::Sent,
        };
        apply_event(1, &db, &bus, ApiEvent::MessageNew(message)).await;

        let published = published_chats(&mut rx);
        assert_eq!(published.len(), 1);
        // Muting only changes where the UI queues the chat; the count stays.
        assert_eq!(published[0].unread_count, 1);
        assert_eq!(published[0].muted_until, forever());
    }
}
