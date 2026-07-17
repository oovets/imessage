//! Content-addressed, encrypted blob cache for media.
//!
//! Layout: `<cache_dir>/<aa>/<sha256(cache_key)>.bin` where `aa` is the first
//! hex byte (keeps directories small). File format: `nonce (12 bytes) ||
//! ChaCha20-Poly1305 ciphertext`. The 256-bit key is created on first use and
//! stored **only** in the secret store (macOS Keychain) — the cache directory
//! alone is undecryptable.
//!
//! Eviction is LRU by file modification time: reads bump the mtime, and
//! [`EncryptedCache::evict_to_limit`] removes the oldest blobs until the
//! directory is back under the configured size budget.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use chacha20poly1305::aead::{Aead, AeadCore, KeyInit, OsRng};
use chacha20poly1305::{ChaCha20Poly1305, Nonce};
use sha2::{Digest, Sha256};
use shared::secrets::{SecretError, SecretStore};

/// Keychain item name for the cache master key.
const KEY_SECRET_NAME: &str = "media-cache-key";
/// Size of the AEAD nonce prepended to every blob file.
const NONCE_LEN: usize = 12;

/// Errors from the encrypted cache.
#[derive(Debug, thiserror::Error)]
pub enum CacheError {
    #[error("cache I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("cache secret store error: {0}")]
    Secret(#[from] SecretError),
    #[error("blob failed decryption (corrupt file or rotated key)")]
    Decrypt,
    #[error("blob failed encryption")]
    Encrypt,
    #[error("stored cache key has invalid length")]
    BadKey,
}

/// Encrypted, size-bounded blob cache. Cheap to clone.
#[derive(Clone)]
pub struct EncryptedCache {
    dir: PathBuf,
    cipher: Arc<ChaCha20Poly1305>,
    max_bytes: u64,
}

impl EncryptedCache {
    /// Open the cache at `dir`, creating the directory and — on first run —
    /// the encryption key (persisted to `secrets`).
    pub fn open(
        dir: &Path,
        secrets: &dyn SecretStore,
        max_bytes: u64,
    ) -> Result<Self, CacheError> {
        std::fs::create_dir_all(dir)?;
        let key_bytes = match secrets.get(KEY_SECRET_NAME)? {
            Some(bytes) => bytes,
            None => {
                let key = ChaCha20Poly1305::generate_key(&mut OsRng);
                secrets.set(KEY_SECRET_NAME, &key[..])?;
                tracing::info!("generated new media cache key");
                key.to_vec()
            }
        };
        let cipher =
            ChaCha20Poly1305::new_from_slice(&key_bytes).map_err(|_| CacheError::BadKey)?;
        Ok(Self {
            dir: dir.to_path_buf(),
            cipher: Arc::new(cipher),
            max_bytes,
        })
    }

    fn blob_path(&self, cache_key: &str) -> PathBuf {
        let digest = Sha256::digest(cache_key.as_bytes());
        let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
        self.dir.join(&hex[..2]).join(format!("{hex}.bin"))
    }

    /// Encrypt and store a blob. Overwrites any existing entry for the key.
    pub async fn put(&self, cache_key: &str, data: &[u8]) -> Result<(), CacheError> {
        let nonce = ChaCha20Poly1305::generate_nonce(&mut OsRng);
        let ciphertext = self
            .cipher
            .encrypt(&nonce, data)
            .map_err(|_| CacheError::Encrypt)?;
        let mut file_contents = Vec::with_capacity(NONCE_LEN + ciphertext.len());
        file_contents.extend_from_slice(&nonce);
        file_contents.extend_from_slice(&ciphertext);

        let path = self.blob_path(cache_key);
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        // Write-then-rename so readers never observe a torn blob.
        let tmp = path.with_extension("tmp");
        tokio::fs::write(&tmp, &file_contents).await?;
        tokio::fs::rename(&tmp, &path).await?;
        Ok(())
    }

    /// Fetch and decrypt a blob; `None` if not cached. Bumps LRU recency.
    pub async fn get(&self, cache_key: &str) -> Result<Option<Vec<u8>>, CacheError> {
        let path = self.blob_path(cache_key);
        let file_contents = match tokio::fs::read(&path).await {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e.into()),
        };
        if file_contents.len() < NONCE_LEN {
            return Err(CacheError::Decrypt);
        }
        let (nonce, ciphertext) = file_contents.split_at(NONCE_LEN);
        let nonce: [u8; NONCE_LEN] = nonce.try_into().map_err(|_| CacheError::Decrypt)?;
        let plaintext = self
            .cipher
            .decrypt(&Nonce::from(nonce), ciphertext)
            .map_err(|_| CacheError::Decrypt)?;

        // LRU touch; best-effort, never fails a read.
        let now = std::fs::FileTimes::new().set_modified(std::time::SystemTime::now());
        if let Ok(file) = std::fs::File::options().append(true).open(&path) {
            let _ = file.set_times(now);
        }
        Ok(Some(plaintext))
    }

    pub async fn contains(&self, cache_key: &str) -> bool {
        tokio::fs::try_exists(self.blob_path(cache_key))
            .await
            .unwrap_or(false)
    }

    pub async fn remove(&self, cache_key: &str) -> Result<(), CacheError> {
        match tokio::fs::remove_file(self.blob_path(cache_key)).await {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.into()),
        }
    }

    /// Decrypt a blob to a user-chosen plaintext path ("Save As…").
    pub async fn export_to(&self, cache_key: &str, dest: &Path) -> Result<bool, CacheError> {
        match self.get(cache_key).await? {
            Some(bytes) => {
                tokio::fs::write(dest, &bytes).await?;
                Ok(true)
            }
            None => Ok(false),
        }
    }

    /// Delete least-recently-used blobs until total size <= budget.
    /// Returns the number of evicted blobs.
    pub async fn evict_to_limit(&self) -> Result<usize, CacheError> {
        let dir = self.dir.clone();
        let max_bytes = self.max_bytes;
        // Directory scan is sync std::fs work; keep it off the async workers.
        let evicted = tokio::task::spawn_blocking(move || evict_sync(&dir, max_bytes))
            .await
            .map_err(|e| {
                CacheError::Io(std::io::Error::other(format!("eviction task failed: {e}")))
            })??;
        if evicted > 0 {
            tracing::info!(evicted, "evicted cache blobs to stay under size budget");
        }
        Ok(evicted)
    }
}

fn evict_sync(dir: &Path, max_bytes: u64) -> Result<usize, CacheError> {
    let mut blobs: Vec<(PathBuf, u64, std::time::SystemTime)> = Vec::new();
    let mut total: u64 = 0;
    for shard in std::fs::read_dir(dir)? {
        let shard = shard?;
        if !shard.file_type()?.is_dir() {
            continue;
        }
        for entry in std::fs::read_dir(shard.path())? {
            let entry = entry?;
            let meta = entry.metadata()?;
            if meta.is_file() {
                total += meta.len();
                blobs.push((
                    entry.path(),
                    meta.len(),
                    meta.modified().unwrap_or(std::time::UNIX_EPOCH),
                ));
            }
        }
    }
    if total <= max_bytes {
        return Ok(0);
    }
    blobs.sort_by_key(|(_, _, mtime)| *mtime);
    let mut evicted = 0;
    for (path, size, _) in blobs {
        if total <= max_bytes {
            break;
        }
        if std::fs::remove_file(&path).is_ok() {
            total = total.saturating_sub(size);
            evicted += 1;
        }
    }
    Ok(evicted)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secrets::MemorySecretStore;

    fn cache(dir: &Path, max: u64) -> (EncryptedCache, MemorySecretStore) {
        let store = MemorySecretStore::new();
        let cache = EncryptedCache::open(dir, &store, max).expect("open");
        (cache, store)
    }

    #[tokio::test]
    async fn roundtrip_and_ciphertext_on_disk() {
        let tmp = tempfile::tempdir().expect("tmpdir");
        let (cache, _store) = cache(tmp.path(), u64::MAX);

        cache.put("photo:1", b"jpeg bytes").await.expect("put");
        let back = cache.get("photo:1").await.expect("get").expect("some");
        assert_eq!(back, b"jpeg bytes");

        // The on-disk file must not contain the plaintext.
        let mut found = false;
        for shard in std::fs::read_dir(tmp.path()).expect("dir") {
            let shard = shard.expect("entry").path();
            if shard.is_dir() {
                for f in std::fs::read_dir(&shard).expect("dir") {
                    let bytes = std::fs::read(f.expect("entry").path()).expect("read");
                    assert!(!bytes
                        .windows(b"jpeg bytes".len())
                        .any(|w| w == b"jpeg bytes"));
                    found = true;
                }
            }
        }
        assert!(found, "blob file exists");
        assert!(cache.get("missing").await.expect("get").is_none());
    }

    #[tokio::test]
    async fn key_persists_across_reopen() {
        let tmp = tempfile::tempdir().expect("tmpdir");
        let store = MemorySecretStore::new();
        let c1 = EncryptedCache::open(tmp.path(), &store, u64::MAX).expect("open");
        c1.put("k", b"data").await.expect("put");
        drop(c1);
        // Same secret store → same key → old blobs stay readable.
        let c2 = EncryptedCache::open(tmp.path(), &store, u64::MAX).expect("reopen");
        assert_eq!(c2.get("k").await.expect("get").as_deref(), Some(&b"data"[..]));
    }

    #[tokio::test]
    async fn wrong_key_fails_decryption() {
        let tmp = tempfile::tempdir().expect("tmpdir");
        let (c1, _s1) = cache(tmp.path(), u64::MAX);
        c1.put("k", b"data").await.expect("put");
        // Fresh secret store generates a different key.
        let (c2, _s2) = cache(tmp.path(), u64::MAX);
        assert!(matches!(c2.get("k").await, Err(CacheError::Decrypt)));
    }

    #[tokio::test]
    async fn eviction_removes_oldest_first() {
        let tmp = tempfile::tempdir().expect("tmpdir");
        // Budget below 2 blobs of ~1KiB payload (+ overhead) forces eviction.
        let (cache, _store) = cache(tmp.path(), 1500);
        cache.put("old", &[0u8; 1024]).await.expect("put");
        // Ensure distinct mtimes even on coarse filesystems.
        tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
        cache.put("new", &[1u8; 1024]).await.expect("put");

        let evicted = cache.evict_to_limit().await.expect("evict");
        assert_eq!(evicted, 1);
        assert!(!cache.contains("old").await);
        assert!(cache.contains("new").await);
    }
}
