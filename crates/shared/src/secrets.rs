//! Abstract secure secret storage.
//!
//! The trait lives here (dependency-free) so that any crate can *require*
//! secret storage without pulling in a platform keychain dependency. The
//! production implementation backed by the macOS Keychain lives in the
//! `cache` crate ([`cache::secrets::KeychainSecretStore`]); tests use an
//! in-memory implementation.
//!
//! Secrets stored through this interface: MTProto session blobs (one per
//! account) and the media-cache encryption key. None of these ever touch the
//! filesystem in plaintext.

/// Errors from a secret store backend.
#[derive(Debug, thiserror::Error)]
pub enum SecretError {
    #[error("secret store backend error: {0}")]
    Backend(String),
}

/// Minimal byte-oriented secret storage.
///
/// Implementations must be thread-safe; calls are cheap and infrequent
/// (login, logout, session save), so the API is synchronous.
pub trait SecretStore: Send + Sync {
    /// Store (create or replace) a secret under `name`.
    fn set(&self, name: &str, value: &[u8]) -> Result<(), SecretError>;
    /// Fetch a secret, `Ok(None)` if it does not exist.
    fn get(&self, name: &str) -> Result<Option<Vec<u8>>, SecretError>;
    /// Delete a secret; deleting a missing secret is not an error.
    fn delete(&self, name: &str) -> Result<(), SecretError>;
}
