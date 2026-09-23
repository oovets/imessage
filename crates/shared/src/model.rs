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
    /// Basic group or supergroup (megagroup). grammers files megagroups under
    /// its `Group` peer even though MTProto models them as channels.
    Group,
    /// Broadcast channel.
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
    /// Until when the account has muted this chat in Telegram, or `None` when
    /// it isn't muted. Already resolved (see [`resolve_mute`]): the chat's own
    /// setting, else the account-wide default for its kind. "Muted forever"
    /// is Telegram's `i32::MAX` instant (2038-01-19).
    pub muted_until: Option<DateTime<Utc>>,
}

/// Telegram's account-wide notification defaults per chat kind (the
/// "Notifications for private chats / groups / channels" settings), as raw
/// `mute_until` unix seconds. `None`, 0 or a past instant = unmuted.
///
/// A chat without a mute setting of its own follows the default for its kind.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct MuteDefaults {
    /// Private chats (Telegram's `notifyUsers`).
    pub private: Option<i32>,
    /// Basic groups and supergroups (`notifyChats`), as official clients do.
    pub group: Option<i32>,
    /// Broadcast channels (`notifyBroadcasts`).
    pub channel: Option<i32>,
}

impl MuteDefaults {
    /// The default that chats of `kind` follow.
    pub fn for_kind(&self, kind: ChatKind) -> Option<i32> {
        match kind {
            ChatKind::Private => self.private,
            ChatKind::Group => self.group,
            ChatKind::Channel => self.channel,
        }
    }
}

/// Resolve Telegram's raw `mute_until` settings to [`Chat::muted_until`].
///
/// `own` is the chat's own setting (`None` = follow the default), `default`
/// the account default for its kind. Telegram unmutes with 0 and leaves a
/// lapsed timed mute in place, so anything at or before `now` is not muted —
/// and an own 0 still overrides a muted default.
pub fn resolve_mute(
    own: Option<i32>,
    default: Option<i32>,
    now: DateTime<Utc>,
) -> Option<DateTime<Utc>> {
    let until = DateTime::from_timestamp(i64::from(own.or(default)?), 0)?;
    (until > now).then_some(until)
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

#[cfg(test)]
mod tests {
    use super::*;

    fn at(secs: i64) -> DateTime<Utc> {
        DateTime::from_timestamp(secs, 0).expect("valid timestamp")
    }

    const NOW: i64 = 1_800_000_000;

    #[test]
    fn own_mute_overrides_the_default() {
        let until = (NOW + 3_600) as i32;
        assert_eq!(
            resolve_mute(Some(until), None, at(NOW)),
            Some(at(NOW + 3_600))
        );
        // An explicit unmute (0) beats a muted default.
        assert_eq!(resolve_mute(Some(0), Some(i32::MAX), at(NOW)), None);
    }

    #[test]
    fn default_applies_without_an_own_setting() {
        assert_eq!(
            resolve_mute(None, Some(i32::MAX), at(NOW)),
            Some(at(i64::from(i32::MAX)))
        );
        assert_eq!(resolve_mute(None, None, at(NOW)), None);
        assert_eq!(resolve_mute(None, Some(0), at(NOW)), None);
    }

    #[test]
    fn lapsed_mute_is_not_muted() {
        assert_eq!(resolve_mute(Some((NOW - 1) as i32), None, at(NOW)), None);
        // Up to and including `now` counts as lapsed.
        assert_eq!(resolve_mute(Some(NOW as i32), None, at(NOW)), None);
        // A lapsed own mute is still the chat's own setting: no fallback.
        assert_eq!(
            resolve_mute(Some((NOW - 1) as i32), Some(i32::MAX), at(NOW)),
            None
        );
    }

    #[test]
    fn defaults_are_picked_by_kind() {
        let defaults = MuteDefaults {
            private: Some(1),
            group: Some(2),
            channel: Some(3),
        };
        assert_eq!(defaults.for_kind(ChatKind::Private), Some(1));
        assert_eq!(defaults.for_kind(ChatKind::Group), Some(2));
        assert_eq!(defaults.for_kind(ChatKind::Channel), Some(3));
    }
}
