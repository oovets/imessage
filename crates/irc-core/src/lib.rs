//! IRC backend for the unified inbox.
//!
//! Built for connecting through a bouncer — IRCCloud's in particular — rather
//! than straight to a network: the bouncer holds the real session and replays
//! what this client missed (with IRCv3 `server-time`), and [`History`] keeps
//! what has been seen, since IRC itself has no history to fetch later.
//!
//! Updates are published on a `tokio::sync::broadcast` channel ([`IrcUpdate`]),
//! which the host forwards to the webview, the same way `slack-core` is wired.

mod client;
mod history;
pub mod irccloud;
pub mod proto;

pub use client::{IrcClient, IrcConfig, IrcUpdate};
pub use history::{BufferInfo, BufferKind, History, IrcMessage, MessageKind, KEEP as HISTORY_KEEP};

/// IRCCloud's bouncer host. Its "Connect with another client…" dialog shows
/// the same host, port 6697 with TLS.
pub const IRCCLOUD_HOST: &str = "bnc.irccloud.com";

/// Put a client id into an IRCCloud bouncer password.
///
/// IRCCloud hands out passwords as `bnc:<secret>`. Written as
/// `bnc@<clientid>:<secret>` instead, the bouncer tracks what *this* client
/// has received and replays only what it missed on reconnect. Tracking starts
/// at the id's first connection: a new id has nothing undelivered, so the
/// first connect replays nothing. Passwords that already carry an id, or are
/// not IRCCloud ones, are returned unchanged.
pub fn with_irccloud_client_id(password: &str, client_id: &str) -> String {
    match password.strip_prefix("bnc:") {
        Some(secret) if !client_id.is_empty() => format!("bnc@{client_id}:{secret}"),
        _ => password.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adds_a_client_id_to_irccloud_passwords_only() {
        assert_eq!(with_irccloud_client_id("bnc:s3cret", "desk1"), "bnc@desk1:s3cret");
        assert_eq!(with_irccloud_client_id("bnc@other:s3cret", "desk1"), "bnc@other:s3cret");
        assert_eq!(with_irccloud_client_id("hunter2", "desk1"), "hunter2");
        assert_eq!(with_irccloud_client_id("bnc:s3cret", ""), "bnc:s3cret");
    }
}
