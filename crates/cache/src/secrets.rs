//! Production and test implementations of [`SecretStore`].

use std::collections::HashMap;
use std::sync::Mutex;

use shared::secrets::{SecretError, SecretStore};

/// Name (account field) of the single Keychain item holding every secret.
const BLOB_ITEM: &str = "secrets";

/// Secret storage backed by the macOS Keychain (via the `keyring` crate).
///
/// All secrets are stored inside **one** generic-password Keychain item
/// (service `dev.stefan.TelegramGui`, account `secrets`) as a small
/// `name<TAB>base64(value)` line map. A single item means a single ACL and
/// therefore a single Keychain prompt for the whole app — instead of one per
/// secret (session, cache key, …). An internal mutex serializes the
/// read-modify-write cycle.
pub struct KeychainSecretStore {
    service: String,
    lock: Mutex<()>,
}

impl KeychainSecretStore {
    pub fn new() -> Self {
        let (qualifier, organization, application) = shared::AppConfig::APP_ID;
        Self {
            service: format!("{qualifier}.{organization}.{application}"),
            lock: Mutex::new(()),
        }
    }

    fn entry(&self) -> Result<keyring::Entry, SecretError> {
        keyring::Entry::new(&self.service, BLOB_ITEM)
            .map_err(|e| SecretError::Backend(e.to_string()))
    }

    fn read_blob(&self) -> Result<HashMap<String, Vec<u8>>, SecretError> {
        let raw = match self.entry()?.get_secret() {
            Ok(bytes) => bytes,
            Err(keyring::Error::NoEntry) => return Ok(HashMap::new()),
            Err(e) => return Err(SecretError::Backend(e.to_string())),
        };
        let text = String::from_utf8_lossy(&raw);
        let mut map = HashMap::new();
        for line in text.lines() {
            if let Some((name, b64)) = line.split_once('\t') {
                if let Ok(value) = base64::Engine::decode(
                    &base64::engine::general_purpose::STANDARD,
                    b64,
                ) {
                    map.insert(name.to_owned(), value);
                }
            }
        }
        Ok(map)
    }

    fn write_blob(&self, map: &HashMap<String, Vec<u8>>) -> Result<(), SecretError> {
        let mut text = String::new();
        for (name, value) in map {
            let b64 =
                base64::Engine::encode(&base64::engine::general_purpose::STANDARD, value);
            text.push_str(name);
            text.push('\t');
            text.push_str(&b64);
            text.push('\n');
        }
        self.entry()?
            .set_secret(text.as_bytes())
            .map_err(|e| SecretError::Backend(e.to_string()))
    }

    fn locked(&self) -> Result<std::sync::MutexGuard<'_, ()>, SecretError> {
        self.lock
            .lock()
            .map_err(|_| SecretError::Backend("poisoned secret lock".into()))
    }
}

impl Default for KeychainSecretStore {
    fn default() -> Self {
        Self::new()
    }
}

impl SecretStore for KeychainSecretStore {
    fn set(&self, name: &str, value: &[u8]) -> Result<(), SecretError> {
        let _guard = self.locked()?;
        let mut map = self.read_blob()?;
        map.insert(name.to_owned(), value.to_vec());
        self.write_blob(&map)
    }

    fn get(&self, name: &str) -> Result<Option<Vec<u8>>, SecretError> {
        let _guard = self.locked()?;
        Ok(self.read_blob()?.get(name).cloned())
    }

    fn delete(&self, name: &str) -> Result<(), SecretError> {
        let _guard = self.locked()?;
        let mut map = self.read_blob()?;
        if map.remove(name).is_some() {
            self.write_blob(&map)?;
        }
        Ok(())
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
