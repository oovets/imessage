//! Update-stream vocabulary handed to the sync engine.

use grammers_client::update::Update;
use grammers_client::tl;
use shared::model::{AccountId, ChatId, Message, MessageId, Presence, UserId};

use crate::{mapping, TgResult};

/// Domain-typed wrapper around grammers' ordered update stream.
///
/// Keeps the raw stream (and its error type) inside this crate, upholding
/// the "no wire types past the boundary" rule.
pub struct EventStream {
    pub(crate) inner: grammers_client::client::UpdateStream,
}

impl EventStream {
    /// Wait for the next update, mapped to an [`ApiEvent`].
    pub async fn next(&mut self, account_id: AccountId) -> TgResult<ApiEvent> {
        let update = self.inner.next().await?;
        Ok(map_update(account_id, &update))
    }

    /// Persist the update-state watermark into the session (call before
    /// shutdown so catch-up resumes from the right place).
    pub async fn sync_state(&self) {
        if let Err(e) = self.inner.sync_update_state().await {
            tracing::warn!("failed to sync update state: {e}");
        }
    }
}

/// A Telegram update, already mapped to domain types.
///
/// This is what `telegram-core` consumes; grammers' `Update` never crosses
/// the crate boundary.
#[derive(Debug, Clone)]
pub enum ApiEvent {
    MessageNew(Message),
    MessageEdited(Message),
    /// Messages were deleted. Telegram only names the chat for channel
    /// deletions; for private/group chats the ids alone identify the rows
    /// (their id sequence is account-wide) and the consumer resolves the
    /// chat from the local database.
    MessagesDeleted {
        channel_chat_id: Option<ChatId>,
        message_ids: Vec<MessageId>,
    },
    Typing {
        chat_id: ChatId,
        user_id: UserId,
    },
    Presence {
        user_id: UserId,
        presence: Presence,
    },
    /// The QR login token was scanned and accepted on another device; the
    /// login flow should call `qr_login_step` again to finish.
    QrLoginAccepted,
    /// An update kind we do not handle (yet). Carried so the sync engine can
    /// trace-log coverage gaps.
    Unhandled,
}

/// Map one grammers update to an [`ApiEvent`].
pub fn map_update(account_id: AccountId, update: &Update) -> ApiEvent {
    match update {
        Update::NewMessage(msg) => ApiEvent::MessageNew(mapping::map_message(account_id, msg)),
        Update::MessageEdited(msg) => {
            ApiEvent::MessageEdited(mapping::map_message(account_id, msg))
        }
        Update::MessageDeleted(deletion) => ApiEvent::MessagesDeleted {
            channel_chat_id: deletion
                .channel_id()
                .and_then(grammers_session::types::PeerId::channel)
                .map(mapping::chat_id_of),
            message_ids: deletion.messages().to_vec(),
        },
        Update::Raw(raw) => map_raw_update(&raw.raw),
        _ => ApiEvent::Unhandled,
    }
}

/// Map the raw updates grammers does not wrap (typing, presence, QR login).
fn map_raw_update(raw: &tl::enums::Update) -> ApiEvent {
    use grammers_session::types::PeerId;
    match raw {
        tl::enums::Update::UserTyping(u) => ApiEvent::Typing {
            // Typing in a private chat: the chat id is the interlocutor.
            chat_id: u.user_id,
            user_id: u.user_id,
        },
        tl::enums::Update::ChatUserTyping(u) => ApiEvent::Typing {
            chat_id: PeerId::chat(u.chat_id)
                .map(mapping::chat_id_of)
                .unwrap_or(-u.chat_id),
            user_id: peer_user_id(&u.from_id).unwrap_or_default(),
        },
        tl::enums::Update::ChannelUserTyping(u) => ApiEvent::Typing {
            chat_id: PeerId::channel(u.channel_id)
                .map(mapping::chat_id_of)
                .unwrap_or_default(),
            user_id: peer_user_id(&u.from_id).unwrap_or_default(),
        },
        tl::enums::Update::UserStatus(u) => ApiEvent::Presence {
            user_id: u.user_id,
            presence: mapping::map_presence(&u.status),
        },
        tl::enums::Update::LoginToken => ApiEvent::QrLoginAccepted,
        _ => ApiEvent::Unhandled,
    }
}

fn peer_user_id(peer: &tl::enums::Peer) -> Option<i64> {
    match peer {
        tl::enums::Peer::User(u) => Some(u.user_id),
        _ => None,
    }
}
