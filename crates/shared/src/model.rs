//! Domain model.
//!
//! These types are the *lingua franca* of the workspace. The `telegram-api`
//! crate maps grammers/MTProto objects **into** these types at its boundary;
//! `database` persists them; `telegram-core` orchestrates them; `ui` serializes
//! them to the webview. No other crate may see a raw Telegram wire type.
//!
//! All types are `Serialize`/`Deserialize` so they can cross the Tauri IPC
//! boundary and be cached as JSON where a dedicated column is overkill.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// Identifier of a locally configured account (one per logged-in Telegram user).
///
/// This is the Telegram user id of the account owner. It is stable across
/// restarts and is used to key every account-scoped row in the database and
/// every Keychain entry.
pub type AccountId = i64;

/// Telegram chat identifier (user, group or channel), in Bot-API style
/// canonical form (positive for users, negative for groups/channels).
pub type ChatId = i64;

/// Message identifier, unique within a chat.
pub type MessageId = i32;

/// Telegram user identifier.
pub type UserId = i64;

/// A logged-in (or logging-in) account.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Account {
    pub id: AccountId,
    /// Phone number in international format, if known.
    pub phone: Option<String>,
    pub first_name: String,
    pub last_name: Option<String>,
    pub username: Option<String>,
    /// Whether this account currently holds a usable session.
    pub authorized: bool,
}

/// The kind of a chat, as far as the UI needs to distinguish.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ChatKind {
    /// One-to-one conversation with a user (or bot).
    Private,
    /// Small or basic group.
    Group,
    /// Broadcast channel or supergroup.
    Channel,
}

/// A conversation as shown in the chat list.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Chat {
    pub account_id: AccountId,
    pub id: ChatId,
    pub kind: ChatKind,
    pub title: String,
    pub username: Option<String>,
    /// Number of messages the server considers unread.
    pub unread_count: i32,
    pub pinned: bool,
    /// Unix timestamp ordering key for the chat list (date of last message).
    pub last_message_at: Option<DateTime<Utc>>,
    /// Short preview text of the last message, pre-rendered for the list.
    pub last_message_preview: Option<String>,
    /// Cache key for the chat's profile photo, or `None` if it has none.
    /// The bytes are fetched on demand and stored in the encrypted cache.
    pub avatar_key: Option<String>,
}

/// Media attached to a message.
///
/// The actual bytes live in the encrypted cache; this enum carries only the
/// metadata needed to render a placeholder and to request a download.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Media {
    Photo {
        /// Stable cache key (derived from Telegram file ids).
        cache_key: String,
        width: i32,
        height: i32,
    },
    Document {
        cache_key: String,
        file_name: String,
        mime_type: String,
        size_bytes: i64,
    },
    Sticker {
        cache_key: String,
        emoji: String,
    },
    /// Media we do not render natively (polls, invoices, …). The string is a
    /// human-readable description such as "📊 Poll".
    Other {
        description: String,
    },
}

/// A single reaction aggregate on a message ("👍 × 3").
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Reaction {
    pub emoji: String,
    pub count: i32,
    /// Whether the account owner is among the reactors.
    pub chosen: bool,
}

/// Delivery state of an outgoing message.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SendState {
    /// Persisted locally, not yet acknowledged by Telegram (offline-first:
    /// messages are written to the DB before the network round-trip).
    Pending,
    Sent,
    Failed,
}

/// A message as stored and rendered.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Message {
    pub account_id: AccountId,
    pub chat_id: ChatId,
    pub id: MessageId,
    pub sender_id: Option<UserId>,
    pub sender_name: Option<String>,
    /// Message text (or caption when media is present).
    pub text: String,
    pub media: Option<Media>,
    pub reactions: Vec<Reaction>,
    pub reply_to: Option<MessageId>,
    pub date: DateTime<Utc>,
    pub edited: bool,
    pub outgoing: bool,
    pub send_state: SendState,
}

/// Online status of a user, as much of it as Telegram exposes.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum Presence {
    Online,
    Offline { last_seen: Option<DateTime<Utc>> },
    /// Coarse statuses ("last seen recently", hidden, …).
    Hidden,
}

/// Progress of a media transfer, emitted while uploading/downloading.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TransferProgress {
    pub cache_key: String,
    pub transferred_bytes: i64,
    pub total_bytes: i64,
    pub done: bool,
}

/// State of the per-account background synchronization loop.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SyncState {
    Connecting,
    /// Catching up on history/dialogs after connect.
    Synchronizing,
    /// Live: receiving updates in real time.
    UpToDate,
    /// Disconnected; will retry with backoff.
    Offline,
}

/// The stages of an interactive login.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "stage", rename_all = "snake_case")]
pub enum LoginStage {
    /// Waiting for the user to enter the code Telegram sent.
    CodeSent,
    /// Account has 2FA enabled; waiting for the cloud password.
    PasswordRequired { hint: Option<String> },
    /// QR login: render this `tg://login?token=…` URL as a QR code.
    /// The token expires at `expires_at` and a fresh one will be emitted.
    QrCode {
        url: String,
        expires_at: DateTime<Utc>,
    },
    /// Login finished; the account is ready.
    Complete { account: Account },
}
