//! Service layer: the operations the UI invokes.
//!
//! Reads come from the database (offline-first); writes follow the pattern
//! *persist locally → broadcast → network → reconcile → broadcast again*, so
//! the UI is always responsive and honest about delivery state.

use std::path::Path;
use std::sync::atomic::{AtomicI32, Ordering};

use chrono::Utc;
use shared::model::{
    AccountId, Chat, ChatId, Message, MessageId, SendState, TransferProgress, UserId,
};
use shared::CoreEvent;

use crate::{Core, CoreResult};

/// Monotonic source of local (pending) message ids. Negative so they can
/// never collide with server-assigned ids; seeded far below zero so multiple
/// app runs stay collision-free within a session's lifetime.
static NEXT_LOCAL_ID: AtomicI32 = AtomicI32::new(-1);

fn next_local_id() -> MessageId {
    NEXT_LOCAL_ID.fetch_sub(1, Ordering::Relaxed)
}

impl Core {
    // ----- reads (database only) ------------------------------------------

    /// The chat list, pinned first then by recency.
    pub async fn chat_list(&self, account_id: AccountId) -> CoreResult<Vec<Chat>> {
        Ok(self.db.chats().list(account_id).await?)
    }

    /// A page of messages, newest first. When the local store has no
    /// history for this chat yet, a page is backfilled from the network
    /// first (then served from the database as usual).
    pub async fn messages(
        &self,
        account_id: AccountId,
        chat_id: ChatId,
        before: Option<(chrono::DateTime<Utc>, MessageId)>,
        limit: u32,
    ) -> CoreResult<Vec<Message>> {
        let local = self
            .db
            .messages()
            .history(account_id, chat_id, before, limit)
            .await?;

        // Decide whether to top up from the network.
        //
        // * Initial page (`before == None`): the chat list seeds only the
        //   single *last* message per chat, so a fresh chat has one row in the
        //   DB. Backfill whenever we hold fewer than a full page, otherwise the
        //   view would show just that one message with nothing to scroll.
        // * Older page (`before == Some`): only reach for the network once the
        //   local store has genuinely run out of older messages.
        let need_backfill = match before {
            None => (local.len() as u32) < limit,
            Some(_) => local.is_empty(),
        };
        if !need_backfill {
            return Ok(local);
        }

        // Backfill: oldest loaded id (or newest page) from the server.
        if let Ok(client) = self.accounts.client(account_id).await {
            let before_id = before.map(|(_, id)| id).filter(|id| *id > 0);
            match client
                .history(account_id, chat_id, before_id, limit as usize)
                .await
            {
                Ok(fetched) => {
                    for message in &fetched {
                        self.db.messages().upsert(message).await?;
                    }
                }
                Err(e) => tracing::warn!("history backfill failed: {e}"),
            }
        } else if local.is_empty() {
            // Offline and nothing cached: surface the empty result as-is.
            return Ok(local);
        }
        Ok(self
            .db
            .messages()
            .history(account_id, chat_id, before, limit)
            .await?)
    }

    // ----- sending ---------------------------------------------------------

    /// Send a text message. Returns the *pending* local message immediately;
    /// reconciliation events follow (`MessageDeleted` for the local id, then
    /// `MessageAdded` with the server-assigned message).
    pub async fn send_message(
        self: &std::sync::Arc<Self>,
        account_id: AccountId,
        chat_id: ChatId,
        text: String,
        reply_to: Option<MessageId>,
    ) -> CoreResult<Message> {
        let local = Message {
            account_id,
            chat_id,
            id: next_local_id(),
            sender_id: Some(account_id),
            sender_name: None,
            text: text.clone(),
            media: None,
            reactions: Vec::new(),
            reply_to,
            date: Utc::now(),
            edited: false,
            outgoing: true,
            send_state: SendState::Pending,
        };
        self.db.messages().upsert(&local).await?;
        self.bus.publish(CoreEvent::MessageAdded {
            message: local.clone(),
        });

        let core = std::sync::Arc::clone(self);
        let local_for_task = local.clone();
        tokio::spawn(async move {
            core.deliver_text(local_for_task, text, reply_to).await;
        });
        Ok(local)
    }

    /// Network half of [`Core::send_message`]; reconciles the pending row.
    async fn deliver_text(&self, local: Message, text: String, reply_to: Option<MessageId>) {
        let result = match self.accounts.client(local.account_id).await {
            Ok(client) => {
                client
                    .send_text(local.account_id, local.chat_id, &text, reply_to)
                    .await
            }
            Err(_) => Err(telegram_api::TgError::NotAuthorized),
        };
        match result {
            Ok(sent) => {
                let confirmed = self
                    .db
                    .messages()
                    .confirm_sent(local.account_id, local.chat_id, local.id, sent.id, sent.date)
                    .await
                    .ok()
                    .flatten();
                let _ = self
                    .db
                    .chats()
                    .touch_last_message(local.account_id, local.chat_id, sent.date, &text)
                    .await;
                self.bus.publish(CoreEvent::MessageDeleted {
                    account_id: local.account_id,
                    chat_id: local.chat_id,
                    message_ids: vec![local.id],
                });
                self.bus.publish(CoreEvent::MessageAdded {
                    message: confirmed.unwrap_or(sent),
                });
            }
            Err(e) => {
                tracing::warn!("send failed: {e}");
                let _ = self
                    .db
                    .messages()
                    .mark_failed(local.account_id, local.chat_id, local.id)
                    .await;
                let mut failed = local;
                failed.send_state = SendState::Failed;
                self.bus.publish(CoreEvent::MessageUpdated { message: failed });
            }
        }
    }

    /// Upload a local file and send it (with optional caption).
    pub async fn send_file(
        &self,
        account_id: AccountId,
        chat_id: ChatId,
        path: &Path,
        caption: &str,
    ) -> CoreResult<Message> {
        let client = self.accounts.client(account_id).await?;
        let sent = client.send_file(account_id, chat_id, path, caption).await?;
        self.db.messages().upsert(&sent).await?;
        self.bus.publish(CoreEvent::MessageAdded {
            message: sent.clone(),
        });
        Ok(sent)
    }

    // ----- editing / deleting / reactions ----------------------------------

    /// Edit a message's text (server first, then local reconcile).
    pub async fn edit_message(
        &self,
        account_id: AccountId,
        chat_id: ChatId,
        message_id: MessageId,
        new_text: &str,
    ) -> CoreResult<()> {
        let client = self.accounts.client(account_id).await?;
        client.edit_text(chat_id, message_id, new_text).await?;
        if let Some(mut message) = self.db.messages().get(account_id, chat_id, message_id).await? {
            message.text = new_text.to_owned();
            message.edited = true;
            self.db.messages().upsert(&message).await?;
            self.bus.publish(CoreEvent::MessageUpdated { message });
        }
        Ok(())
    }

    /// Delete messages for everyone.
    pub async fn delete_messages(
        &self,
        account_id: AccountId,
        chat_id: ChatId,
        message_ids: Vec<MessageId>,
    ) -> CoreResult<()> {
        // Local pending messages (negative ids) never reached the server;
        // only positive ids need the RPC.
        let remote_ids: Vec<MessageId> =
            message_ids.iter().copied().filter(|id| *id > 0).collect();
        if !remote_ids.is_empty() {
            let client = self.accounts.client(account_id).await?;
            client.delete_messages(chat_id, &remote_ids).await?;
        }
        self.db
            .messages()
            .delete(account_id, chat_id, &message_ids)
            .await?;
        self.bus.publish(CoreEvent::MessageDeleted {
            account_id,
            chat_id,
            message_ids,
        });
        Ok(())
    }

    /// Set or clear (`emoji = None`) the account's reaction on a message.
    pub async fn react(
        &self,
        account_id: AccountId,
        chat_id: ChatId,
        message_id: MessageId,
        emoji: Option<String>,
    ) -> CoreResult<()> {
        let client = self.accounts.client(account_id).await?;
        client.react(chat_id, message_id, emoji.as_deref()).await?;

        // Optimistic local update; the authoritative aggregate arrives via
        // the update stream on the next message edit.
        if let Some(mut message) = self.db.messages().get(account_id, chat_id, message_id).await? {
            for reaction in &mut message.reactions {
                if reaction.chosen {
                    reaction.chosen = false;
                    reaction.count -= 1;
                }
            }
            message.reactions.retain(|r| r.count > 0);
            if let Some(emoji) = emoji {
                match message.reactions.iter_mut().find(|r| r.emoji == emoji) {
                    Some(reaction) => {
                        reaction.count += 1;
                        reaction.chosen = true;
                    }
                    None => message.reactions.push(shared::model::Reaction {
                        emoji,
                        count: 1,
                        chosen: true,
                    }),
                }
            }
            self.db.messages().upsert(&message).await?;
            self.bus.publish(CoreEvent::MessageUpdated { message });
        }
        Ok(())
    }

    // ----- chat state ------------------------------------------------------

    /// Mark a chat read (server + local unread counter).
    pub async fn mark_read(&self, account_id: AccountId, chat_id: ChatId) -> CoreResult<()> {
        // Read watermark = newest *server* message id we hold. Channels need a
        // real id (not 0) or the read never registers. Skip pending local
        // messages (negative ids), which have no server id yet.
        let max_id = self
            .db
            .messages()
            .history(account_id, chat_id, None, 20)
            .await?
            .iter()
            .map(|m| m.id)
            .filter(|id| *id > 0)
            .max()
            .unwrap_or(0);

        // Clear the local counter first so the UI reflects the read state even
        // if the account is momentarily offline; the server call follows.
        self.db
            .chats()
            .set_unread_count(account_id, chat_id, 0)
            .await?;
        if let Some(chat) = self.db.chats().get(account_id, chat_id).await? {
            self.bus.publish(CoreEvent::ChatUpdated { chat });
        }
        if let Ok(client) = self.accounts.client(account_id).await {
            match client.mark_read(chat_id, max_id).await {
                Ok(()) => tracing::info!(chat_id, max_id, "marked chat read on server"),
                Err(e) => tracing::warn!(chat_id, max_id, "server mark-read failed: {e}"),
            }
        }
        Ok(())
    }

    /// Broadcast a typing indicator (fire-and-forget semantics).
    pub async fn set_typing(&self, account_id: AccountId, chat_id: ChatId) -> CoreResult<()> {
        let client = self.accounts.client(account_id).await?;
        client.set_typing(chat_id).await?;
        Ok(())
    }

    // ----- search ----------------------------------------------------------

    /// Search messages: instant offline FTS results, topped up with a
    /// server-side search when the account is online.
    pub async fn search(
        &self,
        account_id: AccountId,
        chat_id: Option<ChatId>,
        query: &str,
        limit: u32,
    ) -> CoreResult<Vec<Message>> {
        let mut results = self
            .db
            .messages()
            .search(account_id, chat_id, query, limit)
            .await?;
        if (results.len() as u32) < limit {
            if let Ok(client) = self.accounts.client(account_id).await {
                match client
                    .search(account_id, chat_id, query, limit as usize)
                    .await
                {
                    Ok(remote) => {
                        for message in remote {
                            if !results
                                .iter()
                                .any(|m| m.chat_id == message.chat_id && m.id == message.id)
                            {
                                // Persist so the next identical search is offline.
                                self.db.messages().upsert(&message).await?;
                                results.push(message);
                            }
                        }
                        results.sort_by(|a, b| b.date.cmp(&a.date));
                        results.truncate(limit as usize);
                    }
                    Err(e) => tracing::debug!("remote search unavailable: {e}"),
                }
            }
        }
        Ok(results)
    }

    // ----- media -----------------------------------------------------------

    /// Fetch media bytes: encrypted cache first, network on miss (with
    /// progress events on the bus).
    pub async fn media_bytes(
        &self,
        account_id: AccountId,
        chat_id: ChatId,
        message_id: MessageId,
        cache_key: &str,
    ) -> CoreResult<Vec<u8>> {
        if let Some(bytes) = self.cache.get(cache_key).await? {
            return Ok(bytes);
        }
        let client = self.accounts.client(account_id).await?;
        let bus = self.bus.clone();
        let progress_key = cache_key.to_owned();
        let (key, bytes) = client
            .download_media(
                chat_id,
                message_id,
                Some(Box::new(move |done, total| {
                    bus.publish(CoreEvent::TransferProgress {
                        account_id,
                        progress: TransferProgress {
                            cache_key: progress_key.clone(),
                            transferred_bytes: done,
                            total_bytes: total,
                            done: done >= total && total > 0,
                        },
                    });
                })),
            )
            .await?;
        self.cache.put(&key, &bytes).await?;
        Ok(bytes)
    }

    /// Decrypt a cached blob to a user-chosen plaintext destination.
    pub async fn export_media(&self, cache_key: &str, dest: &Path) -> CoreResult<bool> {
        Ok(self.cache.export_to(cache_key, dest).await?)
    }

    /// Telegram's active reaction emoji, in native order (cached after the
    /// first fetch). Empty if the account is offline and nothing is cached.
    pub async fn available_reactions(&self, account_id: AccountId) -> CoreResult<Vec<String>> {
        if let Some(list) = self.reactions_cache.lock().await.as_ref() {
            return Ok(list.clone());
        }
        let client = self.accounts.client(account_id).await?;
        let list = client.available_reactions().await?;
        *self.reactions_cache.lock().await = Some(list.clone());
        Ok(list)
    }

    /// A group member's profile photo bytes (for sender avatars in groups).
    /// `None` when the user has no photo or can't be resolved.
    ///
    /// Cached per user id rather than per photo id: we don't track members'
    /// photo ids, so this trades auto-refresh-on-photo-change for not needing
    /// a round-trip to discover the key. A changed photo is picked up once the
    /// old blob is evicted.
    pub async fn user_avatar_bytes(
        &self,
        account_id: AccountId,
        user_id: UserId,
    ) -> CoreResult<Option<Vec<u8>>> {
        let key = format!("uavatar-{user_id}");
        if let Some(bytes) = self.cache.get(&key).await? {
            return Ok(Some(bytes));
        }
        // A private-chat id equals the user id, so download_avatar resolves the
        // user peer and fetches their photo. Failure (no photo, or peer not in
        // the session cache) just yields the initials fallback.
        if let Ok(client) = self.accounts.client(account_id).await {
            let _permit = self.avatar_downloads.acquire().await.ok();
            // Re-check the cache: another request for the same user may have
            // fetched it while we waited for a permit.
            if let Some(bytes) = self.cache.get(&key).await? {
                return Ok(Some(bytes));
            }
            match client.download_avatar(user_id).await {
                Ok(Some((_, bytes))) => {
                    self.cache.put(&key, &bytes).await?;
                    return Ok(Some(bytes));
                }
                Ok(None) => {}
                Err(e) => tracing::debug!(user_id, "user avatar unavailable: {e}"),
            }
        }
        Ok(None)
    }

    /// A chat's profile photo bytes: encrypted cache first, network on miss.
    /// Returns `None` when the chat has no photo.
    pub async fn avatar_bytes(
        &self,
        account_id: AccountId,
        chat_id: ChatId,
    ) -> CoreResult<Option<Vec<u8>>> {
        // Use the key recorded during dialog sync to hit the cache without a
        // network round-trip.
        if let Some(key) = self
            .db
            .chats()
            .get(account_id, chat_id)
            .await?
            .and_then(|c| c.avatar_key)
        {
            if let Some(bytes) = self.cache.get(&key).await? {
                return Ok(Some(bytes));
            }
        }
        // Miss (or key unknown): download and cache, bounded by the semaphore.
        if let Ok(client) = self.accounts.client(account_id).await {
            let _permit = self.avatar_downloads.acquire().await.ok();
            if let Some((key, bytes)) = client.download_avatar(chat_id).await? {
                self.cache.put(&key, &bytes).await?;
                return Ok(Some(bytes));
            }
        }
        Ok(None)
    }
}
