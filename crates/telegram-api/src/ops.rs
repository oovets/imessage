//! Messaging operations, all returning domain types.
//!
//! Chat addressing: callers pass canonical (Bot-API style) [`ChatId`]s; the
//! peer authorization needed by MTProto is looked up in the session's peer
//! cache, falling back to an ambient (auth-less) reference which Telegram
//! accepts for peers the account can reach anyway.

use grammers_client::message::{InputMessage, InputReactions};
use grammers_client::tl;
use grammers_session::Session as _;
use grammers_session::types::{PeerId, PeerKind, PeerRef};
use shared::model::{Account, AccountId, Chat, ChatId, Message, MessageId};

use crate::mapping;
use crate::{TelegramClient, TgError, TgResult};

/// A dialog page entry: the chat plus its last message (for seeding history).
pub struct DialogEntry {
    pub chat: Chat,
    pub last_message: Option<Message>,
}

/// Byte-level progress callback for media transfers.
pub type ProgressFn = Box<dyn Fn(i64, i64) + Send + Sync>;

impl TelegramClient {
    /// Resolve a domain chat id to an MTProto peer reference.
    async fn peer_ref(&self, chat_id: ChatId) -> TgResult<PeerRef> {
        let peer_id =
            PeerId::from_bot_api_dialog_id(chat_id).ok_or(TgError::NotFound("chat id"))?;
        match self.session().peer_ref(peer_id).await {
            Ok(Some(peer_ref)) => Ok(peer_ref),
            Ok(None) => Ok(peer_id.to_ambient_ref()),
            Err(e) => Err(TgError::Session(e.to_string())),
        }
    }

    /// The logged-in account's profile.
    pub async fn me(&self) -> TgResult<Account> {
        let user = self.raw().get_me().await?;
        Ok(mapping::map_account(&user))
    }

    /// Fetch up to `limit` dialogs (chat list), most recent first.
    pub async fn list_dialogs(
        &self,
        account_id: AccountId,
        limit: usize,
    ) -> TgResult<Vec<DialogEntry>> {
        let mut iter = self.raw().iter_dialogs();
        let mut entries = Vec::new();
        while let Some(dialog) = iter.next().await? {
            if let Some(chat) = mapping::map_dialog(account_id, &dialog) {
                entries.push(DialogEntry {
                    last_message: dialog
                        .last_message
                        .as_ref()
                        .map(|m| mapping::map_message(account_id, m)),
                    chat,
                });
            }
            if entries.len() >= limit {
                break;
            }
        }
        Ok(entries)
    }

    /// Fetch a page of history older than `before_id` (or the newest page).
    pub async fn history(
        &self,
        account_id: AccountId,
        chat_id: ChatId,
        before_id: Option<MessageId>,
        limit: usize,
    ) -> TgResult<Vec<Message>> {
        let peer = self.peer_ref(chat_id).await?;
        let mut iter = self.raw().iter_messages(peer).limit(limit);
        if let Some(before_id) = before_id {
            iter = iter.offset_id(before_id);
        }
        let mut messages = Vec::new();
        while let Some(msg) = iter.next().await? {
            messages.push(mapping::map_message(account_id, &msg));
            if messages.len() >= limit {
                break;
            }
        }
        Ok(messages)
    }

    /// Send a text message, optionally replying to another message.
    pub async fn send_text(
        &self,
        account_id: AccountId,
        chat_id: ChatId,
        text: &str,
        reply_to: Option<MessageId>,
    ) -> TgResult<Message> {
        let peer = self.peer_ref(chat_id).await?;
        let input = InputMessage::new().text(text).reply_to(reply_to);
        let sent = self.raw().send_message(peer, input).await?;
        Ok(mapping::map_message(account_id, &sent))
    }

    /// Upload a local file and send it (with an optional caption).
    pub async fn send_file(
        &self,
        account_id: AccountId,
        chat_id: ChatId,
        path: &std::path::Path,
        caption: &str,
    ) -> TgResult<Message> {
        let peer = self.peer_ref(chat_id).await?;
        let uploaded = self.raw().upload_file(path).await?;
        let input = InputMessage::new().text(caption).file(uploaded);
        let sent = self.raw().send_message(peer, input).await?;
        Ok(mapping::map_message(account_id, &sent))
    }

    /// Edit a message's text.
    pub async fn edit_text(
        &self,
        chat_id: ChatId,
        message_id: MessageId,
        new_text: &str,
    ) -> TgResult<()> {
        let peer = self.peer_ref(chat_id).await?;
        self.raw()
            .edit_message(peer, message_id, InputMessage::new().text(new_text))
            .await?;
        Ok(())
    }

    /// Delete messages for everyone.
    pub async fn delete_messages(&self, chat_id: ChatId, ids: &[MessageId]) -> TgResult<()> {
        let peer = self.peer_ref(chat_id).await?;
        self.raw().delete_messages(peer, ids).await?;
        Ok(())
    }

    /// The account's active reaction emoji, in Telegram's own order (the same
    /// set native clients show). Premium-only reactions are excluded so the
    /// quick bar never offers something a non-premium account can't send.
    pub async fn available_reactions(&self) -> TgResult<Vec<String>> {
        let result = self
            .raw()
            .invoke(&tl::functions::messages::GetAvailableReactions { hash: 0 })
            .await?;
        Ok(match result {
            tl::enums::messages::AvailableReactions::Reactions(r) => r
                .reactions
                .into_iter()
                .filter_map(|reaction| {
                    let tl::enums::AvailableReaction::Reaction(a) = reaction;
                    if a.inactive || a.premium {
                        None
                    } else {
                        Some(a.reaction)
                    }
                })
                .collect(),
            tl::enums::messages::AvailableReactions::NotModified => Vec::new(),
        })
    }

    /// Set (or with `None`, clear) the account's reaction on a message.
    pub async fn react(
        &self,
        chat_id: ChatId,
        message_id: MessageId,
        emoji: Option<&str>,
    ) -> TgResult<()> {
        let peer = self.peer_ref(chat_id).await?;
        let reactions = match emoji {
            Some(emoji) => InputReactions::emoticon(emoji),
            None => InputReactions::remove(),
        };
        self.raw()
            .send_reactions(peer, message_id, reactions)
            .await?;
        Ok(())
    }

    /// Broadcast a "typing…" indicator for this chat.
    pub async fn set_typing(&self, chat_id: ChatId) -> TgResult<()> {
        let peer = self.peer_ref(chat_id).await?;
        self.raw()
            .action(peer)
            .oneshot(tl::types::SendMessageTypingAction {})
            .await?;
        Ok(())
    }

    /// Mark the chat read up to `max_id` (the newest message the user has
    /// seen).
    ///
    /// grammers' `mark_as_read` hardcodes `max_id = 0`, which reads the whole
    /// history for users/groups but marks *nothing* for channels/supergroups
    /// (there `max_id` is an upper bound, and 0 bounds nothing). We therefore
    /// issue the raw `readHistory` with the real id so channel unread counts
    /// actually clear — and stay cleared across restarts.
    pub async fn mark_read(&self, chat_id: ChatId, max_id: MessageId) -> TgResult<()> {
        let peer = self.peer_ref(chat_id).await?;
        if peer.id.kind() == PeerKind::Channel {
            self.raw()
                .invoke(&tl::functions::channels::ReadHistory {
                    channel: peer.into(),
                    max_id,
                })
                .await?;
        } else {
            self.raw()
                .invoke(&tl::functions::messages::ReadHistory {
                    peer: peer.into(),
                    max_id,
                })
                .await?;
        }
        Ok(())
    }

    /// Server-side message search: within one chat, or globally.
    pub async fn search(
        &self,
        account_id: AccountId,
        chat_id: Option<ChatId>,
        query: &str,
        limit: usize,
    ) -> TgResult<Vec<Message>> {
        let mut messages = Vec::new();
        match chat_id {
            Some(chat_id) => {
                let peer = self.peer_ref(chat_id).await?;
                let mut iter = self.raw().search_messages(peer).query(query).limit(limit);
                while let Some(msg) = iter.next().await? {
                    messages.push(mapping::map_message(account_id, &msg));
                    if messages.len() >= limit {
                        break;
                    }
                }
            }
            None => {
                let mut iter = self.raw().search_all_messages().query(query).limit(limit);
                while let Some(msg) = iter.next().await? {
                    messages.push(mapping::map_message(account_id, &msg));
                    if messages.len() >= limit {
                        break;
                    }
                }
            }
        }
        Ok(messages)
    }

    /// Download a chat's profile photo (small size). Returns the cache key
    /// and JPEG bytes, or `None` if the chat has no photo.
    pub async fn download_avatar(&self, chat_id: ChatId) -> TgResult<Option<(String, Vec<u8>)>> {
        let peer_ref = self.peer_ref(chat_id).await?;
        let peer = self.raw().resolve_peer(peer_ref).await?;
        let Some(photo_id) = mapping::peer_photo_id(&peer) else {
            return Ok(None);
        };
        let Some(chat_photo) = peer.photo(false).await? else {
            return Ok(None);
        };
        let mut bytes = Vec::new();
        let mut iter = self.raw().iter_download(&chat_photo);
        while let Some(chunk) = iter.next().await? {
            bytes.extend_from_slice(&chunk);
        }
        Ok(Some((format!("avatar-{photo_id}"), bytes)))
    }

    /// Download the media attached to a message, reporting chunk progress.
    /// Returns the raw bytes and the media cache key.
    pub async fn download_media(
        &self,
        chat_id: ChatId,
        message_id: MessageId,
        progress: Option<ProgressFn>,
    ) -> TgResult<(String, Vec<u8>)> {
        let peer = self.peer_ref(chat_id).await?;
        let msg = self
            .raw()
            .get_messages_by_id(peer, &[message_id])
            .await?
            .into_iter()
            .next()
            .flatten()
            .ok_or(TgError::NotFound("message"))?;
        let media = msg.media().ok_or(TgError::NotFound("media"))?;
        let cache_key =
            mapping::media_cache_key(&media).ok_or(TgError::NotFound("downloadable media"))?;

        let total = media_size(&media);
        let mut bytes: Vec<u8> = Vec::new();
        let mut iter = self.raw().iter_download(&media);
        while let Some(chunk) = iter.next().await? {
            bytes.extend_from_slice(&chunk);
            if let Some(progress) = &progress {
                progress(bytes.len() as i64, total.max(bytes.len() as i64));
            }
        }
        Ok((cache_key, bytes))
    }
}

fn media_size(media: &grammers_client::media::Media) -> i64 {
    match media {
        grammers_client::media::Media::Photo(p) => {
            p.size().map(|s| s as i64).unwrap_or(0)
        }
        grammers_client::media::Media::Document(d) => {
            d.size().map(|s| s as i64).unwrap_or(0)
        }
        grammers_client::media::Media::Sticker(s) => {
            s.document.size().map(|s| s as i64).unwrap_or(0)
        }
        _ => 0,
    }
}
