//! Update-stream vocabulary handed to the sync engine.

use grammers_client::update::Update;
use grammers_client::tl;
use shared::model::{AccountId, ChatId, ChatKind, Message, MessageId, Presence, UserId};

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
    /// The account changed one chat's notification settings (on any
    /// device). `mute_until` is the chat's own raw setting: `None` = follow
    /// the account default, 0 or a past instant = unmuted.
    ChatMuteChanged {
        chat_id: ChatId,
        mute_until: Option<i32>,
    },
    /// The account default for one chat kind changed; it applies to every
    /// chat of that kind without a setting of its own.
    MuteDefaultChanged {
        kind: ChatKind,
        mute_until: Option<i32>,
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

/// Map the raw updates grammers does not wrap (typing, presence, mutes, QR
/// login).
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
        tl::enums::Update::NotifySettings(u) => map_notify_settings(u),
        tl::enums::Update::LoginToken => ApiEvent::QrLoginAccepted,
        _ => ApiEvent::Unhandled,
    }
}

fn map_notify_settings(u: &tl::types::UpdateNotifySettings) -> ApiEvent {
    let mute_until = mapping::raw_mute_until(&u.notify_settings);
    let kind = match &u.peer {
        tl::enums::NotifyPeer::Peer(p) => {
            return ApiEvent::ChatMuteChanged {
                chat_id: mapping::chat_id_of(grammers_session::types::PeerId::from(&p.peer)),
                mute_until,
            };
        }
        tl::enums::NotifyPeer::NotifyUsers => ChatKind::Private,
        // Official clients apply the "groups" default to supergroups too,
        // which is where grammers (and so ChatKind) files them.
        tl::enums::NotifyPeer::NotifyChats => ChatKind::Group,
        tl::enums::NotifyPeer::NotifyBroadcasts => ChatKind::Channel,
        // Per-topic settings in forum groups: the chat list has no topics.
        tl::enums::NotifyPeer::NotifyForumTopic(_) => return ApiEvent::Unhandled,
    };
    ApiEvent::MuteDefaultChanged { kind, mute_until }
}

fn peer_user_id(peer: &tl::enums::Peer) -> Option<i64> {
    match peer {
        tl::enums::Peer::User(u) => Some(u.user_id),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn notify_update(peer: tl::enums::NotifyPeer, mute_until: Option<i32>) -> tl::enums::Update {
        tl::types::UpdateNotifySettings {
            peer,
            notify_settings: tl::types::PeerNotifySettings {
                show_previews: None,
                silent: None,
                mute_until,
                ios_sound: None,
                android_sound: None,
                other_sound: None,
                stories_muted: None,
                stories_hide_sender: None,
                stories_ios_sound: None,
                stories_android_sound: None,
                stories_other_sound: None,
            }
            .into(),
        }
        .into()
    }

    fn peer(peer: tl::enums::Peer) -> tl::enums::NotifyPeer {
        tl::types::NotifyPeer { peer }.into()
    }

    #[test]
    fn per_chat_notify_settings_name_the_chat() {
        let user = peer(tl::types::PeerUser { user_id: 42 }.into());
        assert!(matches!(
            map_raw_update(&notify_update(user, Some(i32::MAX))),
            ApiEvent::ChatMuteChanged {
                chat_id: 42,
                mute_until: Some(i32::MAX)
            }
        ));
        let channel = peer(tl::types::PeerChannel { channel_id: 1234 }.into());
        assert!(matches!(
            map_raw_update(&notify_update(channel, Some(0))),
            ApiEvent::ChatMuteChanged {
                chat_id: -1_000_000_001_234,
                mute_until: Some(0)
            }
        ));
        let group = peer(tl::types::PeerChat { chat_id: 77 }.into());
        assert!(matches!(
            map_raw_update(&notify_update(group, None)),
            ApiEvent::ChatMuteChanged {
                chat_id: -77,
                mute_until: None
            }
        ));
    }

    #[test]
    fn type_defaults_map_to_their_chat_kind() {
        use tl::enums::NotifyPeer;
        for (peer, expected) in [
            (NotifyPeer::NotifyUsers, ChatKind::Private),
            (NotifyPeer::NotifyChats, ChatKind::Group),
            (NotifyPeer::NotifyBroadcasts, ChatKind::Channel),
        ] {
            match map_raw_update(&notify_update(peer, Some(5))) {
                ApiEvent::MuteDefaultChanged { kind, mute_until } => {
                    assert_eq!(kind, expected);
                    assert_eq!(mute_until, Some(5));
                }
                other => panic!("expected a default change, got {other:?}"),
            }
        }
    }

    #[test]
    fn forum_topic_settings_are_ignored() {
        let topic = tl::types::NotifyForumTopic {
            peer: tl::types::PeerChannel { channel_id: 1234 }.into(),
            top_msg_id: 1,
        }
        .into();
        assert!(matches!(
            map_raw_update(&notify_update(topic, Some(i32::MAX))),
            ApiEvent::Unhandled
        ));
    }
}
