//! Production and test implementations of [`SecretStore`].

use std::collections::HashMap;
use std::sync::Mutex;

use shared::secrets::{SecretError, SecretStore};

/// Secret storage backed by the macOS Keychain (via the `keyring` crate,
/// which uses the native Security framework on macOS).
///
/// Each secret becomes a generic-password Keychain item with service name
/// `dev.stefan.TelegramGui` and the secret name as the account field, so
/// items are inspectable in Keychain Access.app.
pub struct KeychainSecretStore {
    service: String,
}

impl KeychainSecretStore {
    pub fn new() -> Self {
        let (qualifier, organization, application) = shared::AppConfig::APP_ID;
        Self {
            service: format!("{qualifier}.{organization}.{application}"),
        }
    }

    fn entry(&self, name: &str) -> Result<keyring::Entry, SecretError> {
        keyring::Entry::new(&self.service, name)
            .map_err(|e| SecretError::Backend(e.to_string()))
    }
}

impl Default for KeychainSecretStore {
    fn default() -> Self {
        Self::new()
    }
}

impl SecretStore for KeychainSecretStore {
    fn set(&self, name: &str, value: &[u8]) -> Result<(), SecretError> {
        self.entry(name)?
            .set_secret(value)
            .map_err(|e| SecretError::Backend(e.to_string()))
    }

    fn get(&self, name: &str) -> Result<Option<Vec<u8>>, SecretError> {
        match self.entry(name)?.get_secret() {
            Ok(bytes) => Ok(Some(bytes)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(SecretError::Backend(e.to_string())),
        }
    }

    fn delete(&self, name: &str) -> Result<(), SecretError> {
        match self.entry(name)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(SecretError::Backend(e.to_string())),
        }
    }
}

/// In-memory secret store for tests and headless CI (no Keychain prompts).
#[derive(Default)]
pub struct MemorySecretStore {
    values: Mutex<HashMap<String, Vec<u8>>>,
}

impl MemorySecretStore {
    pub fn new() -> Self {
        Self::default()
    }
}

impl SecretStore for MemorySecretStore {
    fn set(&self, name: &str, value: &[u8]) -> Result<(), SecretError> {
        let mut map = self
            .values
            .lock()
            .map_err(|_| SecretError::Backend("poisoned lock".into()))?;
        map.insert(name.to_owned(), value.to_vec());
        Ok(())
    }

    fn get(&self, name: &str) -> Result<Option<Vec<u8>>, SecretError> {
        let map = self
            .values
            .lock()
            .map_err(|_| SecretError::Backend("poisoned lock".into()))?;
        Ok(map.get(name).cloned())
    }

    fn delete(&self, name: &str) -> Result<(), SecretError> {
        let mut map = self
            .values
            .lock()
            .map_err(|_| SecretError::Backend("poisoned lock".into()))?;
        map.remove(name);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_store_roundtrip() {
        let store = MemorySecretStore::new();
        assert!(store.get("k").expect("get").is_none());
        store.set("k", b"v").expect("set");
        assert_eq!(store.get("k").expect("get").as_deref(), Some(&b"v"[..]));
        store.delete("k").expect("delete");
        store.delete("k").expect("idempotent delete");
        assert!(store.get("k").expect("get").is_none());
    }
}
