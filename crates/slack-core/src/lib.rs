//! Slack backend for the unified inbox.
//!
//! Extracted from the `slack_rust` terminal client: the Web API calls, the
//! Socket Mode event stream, and the models — none of the TUI. Updates are
//! published on a `tokio::sync::broadcast` channel (`SlackUpdate`), which the
//! host app forwards to the frontend as Tauri events, mirroring how
//! `telegram-core` is wired in.
//!
//! Auth is the same pair the TUI uses: a user token (`xoxp-`) for Web API calls
//! so actions happen *as the user*, and an app-level token (`xapp-`) to open the
//! Socket Mode stream.

mod client;
mod model;

pub use client::*;
pub use model::{ChatInfo, ChatSection};
