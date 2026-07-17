//! The application event bus vocabulary.
//!
//! A single broadcast channel of [`CoreEvent`] connects the sync engine
//! (producer) to the UI bridge and the notification service (consumers).
//!
//! Design rules:
//!
//! * Events are **facts, not commands** — they describe something that already
//!   happened and was already persisted. A consumer that misses an event (e.g.
//!   broadcast lag) can always recover by re-reading the database.
//! * Events carry full payloads (not just ids) so the common consumer path
//!   needs no follow-up query, but they must stay cheap to clone.

use serde::{Deserialize, Serialize};

use crate::model::{
    AccountId, Chat, ChatId, LoginStage, Message, MessageId, Presence, SyncState,
    TransferProgress, UserId,
};

/// Everything that can happen in the core, in one enum.
///
/// `serde(tag = "kind")` so the frontend can switch on a single string field.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CoreEvent {
    /// A message was inserted (received, sent locally, or backfilled).
    MessageAdded {
        message: Message,
    },
    /// An existing message changed (edit, reaction change, send-state change).
    MessageUpdated {
        message: Message,
    },
    MessageDeleted {
        account_id: AccountId,
        chat_id: ChatId,
        message_ids: Vec<MessageId>,
    },
    /// Chat metadata changed (title, unread count, pin, last-message preview).
    ChatUpdated {
        chat: Chat,
    },
    /// A user is typing (or recording, uploading, …) in a chat. Transient:
    /// consumers should expire it after a few seconds.
    Typing {
        account_id: AccountId,
        chat_id: ChatId,
        user_id: UserId,
    },
    PresenceChanged {
        account_id: AccountId,
        user_id: UserId,
        presence: Presence,
    },
    TransferProgress {
        account_id: AccountId,
        progress: TransferProgress,
    },
    SyncStateChanged {
        account_id: AccountId,
        state: SyncState,
    },
    /// Progress of an interactive login flow (see [`LoginStage`]).
    Login {
        /// `None` until the account id is known (QR/code flows start anonymous).
        account_id: Option<AccountId>,
        stage: LoginStage,
    },
    /// The account's session became invalid (revoked from another device).
    LoggedOut {
        account_id: AccountId,
    },
}

impl CoreEvent {
    /// The account this event belongs to, when it is account-scoped.
    pub fn account_id(&self) -> Option<AccountId> {
        match self {
            CoreEvent::MessageAdded { message } | CoreEvent::MessageUpdated { message } => {
                Some(message.account_id)
            }
            CoreEvent::MessageDeleted { account_id, .. }
            | CoreEvent::Typing { account_id, .. }
            | CoreEvent::PresenceChanged { account_id, .. }
            | CoreEvent::TransferProgress { account_id, .. }
            | CoreEvent::SyncStateChanged { account_id, .. }
            | CoreEvent::LoggedOut { account_id } => Some(*account_id),
            CoreEvent::ChatUpdated { chat } => Some(chat.account_id),
            CoreEvent::Login { account_id, .. } => *account_id,
        }
    }
}
