//! Pure grammers → domain mapping functions.
//!
//! Everything here is a total function from wire types to `shared::model`
//! types; no I/O. Keeping the mapping in one file makes the wire-format
//! blast radius of a grammers upgrade visible in a single diff.

use chrono::{DateTime, TimeZone, Utc};
use grammers_client::message::Message as TgMessage;
use grammers_client::peer::{Peer, User};
use grammers_client::{media, tl};
use grammers_session::types::PeerId;
use shared::model::{
    Account, AccountId, Chat, ChatId, ChatKind, Media, Message, Presence, Reaction, SendState,
    UserId,
};

/// Map the logged-in user to a local [`Account`].
pub fn map_account(user: &User) -> Account {
    Account {
        id: user.id().bare_id_unchecked(),
        phone: user.phone().map(str::to_owned),
        first_name: user.first_name().unwrap_or_default().to_owned(),
        last_name: user.last_name().map(str::to_owned),
        username: user.username().map(str::to_owned),
        authorized: true,
    }
}

/// Canonical (Bot-API style) chat id for a peer.
pub fn chat_id_of(peer_id: PeerId) -> ChatId {
    peer_id.bot_api_dialog_id_unchecked()
}

/// Bare user id for sender fields (positive i64).
pub fn user_id_of(peer_id: PeerId) -> Option<UserId> {
    peer_id.bare_id()
}

pub fn map_chat_kind(peer: &Peer) -> ChatKind {
    match peer {
        Peer::User(_) => ChatKind::Private,
        Peer::Group(_) => ChatKind::Group,
        Peer::Channel(_) => ChatKind::Channel,
    }
}

/// Map a dialog to a [`Chat`]. Returns `None` for folder pseudo-dialogs.
pub fn map_dialog(account_id: AccountId, dialog: &grammers_client::peer::Dialog) -> Option<Chat> {
    let raw = match &dialog.raw {
        tl::enums::Dialog::Dialog(d) => d,
        tl::enums::Dialog::Folder(_) => return None,
    };
    let peer = dialog.peer();
    let last = dialog.last_message.as_ref();
    Some(Chat {
        account_id,
        id: chat_id_of(peer.id()),
        kind: map_chat_kind(peer),
        title: peer
            .name()
            .filter(|n| !n.is_empty())
            .unwrap_or("Deleted account")
            .to_owned(),
        username: peer.username().map(str::to_owned),
        unread_count: raw.unread_count,
        pinned: raw.pinned,
        last_message_at: last.map(|m| m.date()),
        last_message_preview: last.map(preview_text),
        avatar_key: peer_photo_id(peer).map(|id| format!("avatar-{id}")),
    })
}

/// The profile-photo id of a peer, if it has a photo.
///
/// The id is stable per photo, so it doubles as the cache key: when a peer
/// changes their photo the id changes and the old cached blob is simply left
/// to LRU eviction.
pub fn peer_photo_id(peer: &Peer) -> Option<i64> {
    match peer {
        Peer::User(u) => u.photo().map(|p| p.photo_id),
        Peer::Group(g) => g.photo().map(|p| p.photo_id),
        Peer::Channel(c) => c.photo().map(|p| p.photo_id),
    }
}

/// Map a full message.
pub fn map_message(account_id: AccountId, msg: &TgMessage) -> Message {
    Message {
        account_id,
        chat_id: chat_id_of(msg.peer_id()),
        id: msg.id(),
        sender_id: msg.sender_id().and_then(user_id_of),
        sender_name: msg
            .sender()
            .and_then(|p| p.name().map(str::to_owned)),
        text: msg.text().to_owned(),
        media: msg.media().as_ref().and_then(map_media),
        reactions: map_reactions(msg),
        reply_to: msg.reply_to_message_id(),
        date: msg.date(),
        edited: msg.edit_date().is_some(),
        outgoing: msg.outgoing(),
        send_state: SendState::Sent,
    }
}

/// One-line preview used in the chat list.
pub fn preview_text(msg: &TgMessage) -> String {
    let text = msg.text();
    if !text.is_empty() {
        let mut preview: String = text.chars().take(120).collect();
        if text.chars().count() > 120 {
            preview.push('…');
        }
        return preview;
    }
    match msg.media() {
        Some(media::Media::Photo(_)) => "📷 Photo".to_owned(),
        Some(media::Media::Sticker(s)) => format!("{} Sticker", s.emoji()),
        Some(media::Media::Document(d)) => {
            format!("📎 {}", d.name().filter(|n| !n.is_empty()).unwrap_or("File"))
        }
        Some(media::Media::Contact(_)) => "👤 Contact".to_owned(),
        Some(media::Media::Poll(_)) => "📊 Poll".to_owned(),
        Some(media::Media::Geo(_)) | Some(media::Media::GeoLive(_)) => "📍 Location".to_owned(),
        Some(media::Media::Venue(_)) => "📍 Venue".to_owned(),
        Some(media::Media::Dice(_)) => "🎲 Dice".to_owned(),
        Some(media::Media::WebPage(_)) => "🔗 Link".to_owned(),
        Some(_) => "Attachment".to_owned(),
        None => String::new(),
    }
}

/// Stable cache key for a piece of media (drives the encrypted blob cache).
pub fn media_cache_key(media: &media::Media) -> Option<String> {
    match media {
        media::Media::Photo(p) => Some(format!("photo-{}", p.id())),
        media::Media::Document(d) => Some(format!("doc-{}", d.id())),
        media::Media::Sticker(s) => Some(format!("doc-{}", s.document.id())),
        _ => None,
    }
}

/// Map media metadata (bytes live in the encrypted cache, fetched on demand).
pub fn map_media(m: &media::Media) -> Option<Media> {
    match m {
        media::Media::Photo(p) => {
            let (width, height) = p
                .thumbs()
                .into_iter()
                .filter_map(|t| match t {
                    media::PhotoSize::Size(s) => Some((s.width, s.height)),
                    media::PhotoSize::Cached(s) => Some((s.width, s.height)),
                    media::PhotoSize::Progressive(s) => Some((s.width, s.height)),
                    _ => None,
                })
                .max_by_key(|(w, h)| w.saturating_mul(*h))
                .unwrap_or((0, 0));
            Some(Media::Photo {
                cache_key: format!("photo-{}", p.id()),
                width,
                height,
            })
        }
        media::Media::Sticker(s) => Some(Media::Sticker {
            cache_key: format!("doc-{}", s.document.id()),
            emoji: s.emoji().to_owned(),
        }),
        media::Media::Document(d) => Some(Media::Document {
            cache_key: format!("doc-{}", d.id()),
            file_name: d
                .name()
                .filter(|n| !n.is_empty())
                .unwrap_or("file")
                .to_owned(),
            mime_type: d.mime_type().unwrap_or("application/octet-stream").to_owned(),
            size_bytes: d.size().map(|s| s as i64).unwrap_or(0),
        }),
        media::Media::Contact(_) => Some(Media::Other {
            description: "👤 Contact".to_owned(),
        }),
        media::Media::Poll(_) => Some(Media::Other {
            description: "📊 Poll".to_owned(),
        }),
        media::Media::Geo(_) | media::Media::GeoLive(_) | media::Media::Venue(_) => {
            Some(Media::Other {
                description: "📍 Location".to_owned(),
            })
        }
        media::Media::Dice(_) => Some(Media::Other {
            description: "🎲 Dice".to_owned(),
        }),
        // Web previews render from the message text; no separate media entry.
        media::Media::WebPage(_) => None,
        _ => Some(Media::Other {
            description: "Attachment".to_owned(),
        }),
    }
}

/// Extract the reaction aggregates from the raw message.
pub fn map_reactions(msg: &TgMessage) -> Vec<Reaction> {
    let tl::enums::Message::Message(raw) = &msg.raw else {
        return Vec::new();
    };
    let Some(tl::enums::MessageReactions::Reactions(reactions)) = &raw.reactions else {
        return Vec::new();
    };
    reactions
        .results
        .iter()
        .filter_map(|rc| {
            let tl::enums::ReactionCount::Count(rc) = rc;
            let emoji = match &rc.reaction {
                tl::enums::Reaction::Emoji(e) => e.emoticon.clone(),
                tl::enums::Reaction::CustomEmoji(_) => "⭐".to_owned(),
                _ => return None,
            };
            Some(Reaction {
                emoji,
                count: rc.count,
                chosen: rc.chosen_order.is_some(),
            })
        })
        .collect()
}

/// Map a raw user status to [`Presence`].
pub fn map_presence(status: &tl::enums::UserStatus) -> Presence {
    match status {
        tl::enums::UserStatus::Online(_) => Presence::Online,
        tl::enums::UserStatus::Offline(o) => Presence::Offline {
            last_seen: Utc.timestamp_opt(o.was_online as i64, 0).single(),
        },
        _ => Presence::Hidden,
    }
}

/// Unix seconds → UTC datetime, clamped to epoch on invalid input.
pub fn timestamp(secs: i32) -> DateTime<Utc> {
    Utc.timestamp_opt(secs as i64, 0)
        .single()
        .unwrap_or(DateTime::<Utc>::UNIX_EPOCH)
}
