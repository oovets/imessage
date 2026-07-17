//! # telegram-api
//!
//! The MTProto boundary of the application, built on
//! [grammers](https://github.com/Lonami/grammers).
//!
//! ## Boundary rule
//!
//! This is the **only** crate that sees grammers / TL wire types. Everything
//! it returns to the rest of the workspace is a `shared::model` domain type or
//! an [`updates::ApiEvent`]. This keeps the protocol library swappable and the
//! business logic (`telegram-core`) free of wire-format concerns.
//!
//! ## Pieces
//!
//! * [`session::KeychainSession`] — a grammers `Session` implementation whose
//!   persistent form lives in the macOS Keychain (never plaintext on disk).
//! * [`client::TelegramClient`] — connection lifecycle: sender pool, update
//!   stream, reconnect handle.
//! * [`auth`] — interactive login flows: SMS/app code, 2FA password and
//!   (feature `qr-login`) QR-code login via raw `auth.exportLoginToken`.
//! * [`ops`] — messaging operations (send/edit/delete/react/search/…).
//! * [`mapping`] — pure functions from grammers types to domain types.
//! * [`updates`] — the update-stream vocabulary handed to the sync engine.

pub mod auth;
pub mod client;
pub mod mapping;
pub mod ops;
pub mod session;
pub mod updates;

pub use client::TelegramClient;
pub use updates::ApiEvent;

/// Errors surfaced by the Telegram boundary.
#[derive(Debug, thiserror::Error)]
pub enum TgError {
    /// An RPC invocation failed (network problem or server-side error).
    #[error("telegram call failed: {0}")]
    Invocation(#[from] grammers_client::InvocationError),
    /// Authorization is missing or was revoked.
    #[error("not authorized")]
    NotAuthorized,
    /// The login flow failed in a way the user must act on.
    #[error("sign-in failed: {0}")]
    SignIn(String),
    /// The session storage misbehaved (Keychain unavailable, corrupt data).
    #[error("session storage failed: {0}")]
    Session(String),
    /// A referenced entity (chat, message, media) could not be found.
    #[error("not found: {0}")]
    NotFound(&'static str),
    /// Local I/O while uploading/downloading.
    #[error("file I/O failed: {0}")]
    Io(#[from] std::io::Error),
}

/// Convenience alias used across the crate.
pub type TgResult<T> = Result<T, TgError>;

impl TgError {
    /// Whether this error carries the given Telegram RPC error name
    /// (supports the same `*` wildcard as grammers' matcher).
    pub fn is_rpc(&self, name: &str) -> bool {
        matches!(self, TgError::Invocation(inv) if inv.is(name))
    }

    /// Whether the server has revoked this session (the user must log in
    /// again; retrying is pointless).
    pub fn is_auth_revoked(&self) -> bool {
        matches!(self, TgError::NotAuthorized)
            || self.is_rpc("AUTH_KEY_UNREGISTERED")
            || self.is_rpc("SESSION_REVOKED")
            || self.is_rpc("USER_DEACTIVATED")
    }
}
