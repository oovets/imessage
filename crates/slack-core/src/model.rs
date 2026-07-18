//! Slack domain types.
//!
//! These lived in the TUI's `app` module in slack_rust, but they carry no UI
//! concerns — they are the shape the Slack Web API is decoded into, so they
//! belong with the client.

use serde::Serialize;

/// How Slack classifies a conversation. Ordered so the UI can group by it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
pub enum ChatSection {
    Public = 0,
    Private = 1,
    Shared = 2,
    Group = 3,
    DirectMessage = 4,
    Bot = 5,
}

impl ChatSection {
    pub fn label(&self) -> &'static str {
        match self {
            ChatSection::Public => "Public Channels",
            ChatSection::Private => "Private Channels",
            ChatSection::Shared => "Shared Channels",
            ChatSection::Group => "Group Chats",
            ChatSection::DirectMessage => "DMs",
            ChatSection::Bot => "Bots & Apps",
        }
    }
}

/// A conversation as listed by `conversations.list` / `users.conversations`.
#[derive(Debug, Clone, Serialize)]
pub struct ChatInfo {
    pub id: String,
    pub name: String,
    pub username: Option<String>,
    pub unread: u32,
    pub section: ChatSection,
}
