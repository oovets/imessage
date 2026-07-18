//! # cache
//!
//! Local encrypted storage:
//!
//! * [`secrets`] — the production [`shared::secrets::SecretStore`]
//!   implementations: macOS Keychain ([`secrets::KeychainSecretStore`]) and an
//!   in-memory store for tests.
//! * [`blob`] — [`blob::EncryptedCache`], a content-addressed media cache.
//!   Every blob on disk is ChaCha20-Poly1305 encrypted with a key that lives
//!   only in the Keychain, so a stolen cache directory is useless.

pub mod blob;
pub mod secrets;

pub use blob::{CacheError, EncryptedCache};
