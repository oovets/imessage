//! # telegram-core
//!
//! The application's business logic. This crate wires the three
//! infrastructure crates together and exposes a single façade — [`Core`] —
//! that the UI talks to:
//!
//! ```text
//!            ┌───────────────┐   commands    ┌──────────┐
//!   UI  ───▶ │     Core      │ ────────────▶ │ services │──▶ database (read/write)
//!            │  (this crate) │               └──────────┘──▶ telegram-api (network)
//!            └──────┬────────┘                    ▲
//!                   │ broadcast<CoreEvent>        │ persisted facts
//!                   ▼                        ┌────┴─────┐
//!               UI bridge  ◀──────────────── │   sync   │◀── update stream
//!                                            └──────────┘
//! ```
//!
//! Rules enforced here:
//!
//! * **Offline-first** — every fact is written to the database *before* the
//!   corresponding [`CoreEvent`] is broadcast; consumers re-read from the DB
//!   and can always recover from missed events.
//! * **One runtime per account** — [`accounts::AccountManager`] owns a
//!   client + sync task pair per logged-in account.

pub mod accounts;
pub mod bus;
pub mod services;
pub mod sync;

use std::path::PathBuf;
use std::sync::Arc;

use cache::EncryptedCache;
use database::Database;
use shared::secrets::SecretStore;
use shared::{AppConfig, CoreEvent};

pub use bus::EventBus;

/// Errors surfaced to the UI layer.
#[derive(Debug, thiserror::Error)]
pub enum CoreError {
    #[error(transparent)]
    Db(#[from] database::DbError),
    #[error(transparent)]
    Telegram(#[from] telegram_api::TgError),
    #[error(transparent)]
    Cache(#[from] cache::CacheError),
    #[error("configuration error: {0}")]
    Config(#[from] shared::config::ConfigError),
    #[error("no such account: {0}")]
    UnknownAccount(shared::model::AccountId),
    #[error("no login flow in progress")]
    NoPendingLogin,
}

pub type CoreResult<T> = Result<T, CoreError>;

/// The application core. One instance per process, shared behind `Arc`.
pub struct Core {
    pub config: AppConfig,
    pub db: Database,
    pub cache: EncryptedCache,
    pub bus: EventBus,
    pub accounts: accounts::AccountManager,
    /// Cached list of active reaction emoji (rarely changes; fetched once).
    reactions_cache: tokio::sync::Mutex<Option<Vec<String>>>,
    /// Bounds concurrent avatar downloads. The UI requests many avatars at
    /// once (chat list + every group sender); firing them all in parallel
    /// trips Telegram's FLOOD_WAIT on `upload.getFile`. Cache hits bypass this.
    avatar_downloads: tokio::sync::Semaphore,
}

impl Core {
    /// Boot the core: open storage, then reconnect every account that has a
    /// stored session (background sync starts immediately per account).
    pub async fn start(
        config: AppConfig,
        secrets: Arc<dyn SecretStore>,
    ) -> CoreResult<Arc<Self>> {
        config.require_api_credentials()?;

        let db_path: PathBuf = config.storage.data_dir.join("telegram_gui.db");
        let db = Database::open(&db_path).await?;
        let cache = EncryptedCache::open(
            &config.storage.cache_dir,
            secrets.as_ref(),
            config.storage.cache_max_bytes,
        )?;
        let bus = EventBus::new();
        let accounts = accounts::AccountManager::new(
            config.clone(),
            db.clone(),
            bus.clone(),
            secrets,
        );

        let core = Arc::new(Self {
            config,
            db,
            cache,
            bus,
            accounts,
            reactions_cache: tokio::sync::Mutex::new(None),
            avatar_downloads: tokio::sync::Semaphore::new(3),
        });
        core.accounts.resume_all().await?;

        // Trim the media cache in the background; never blocks startup.
        let cache = core.cache.clone();
        tokio::spawn(async move {
            if let Err(e) = cache.evict_to_limit().await {
                tracing::warn!("cache eviction failed: {e}");
            }
        });

        Ok(core)
    }

    /// Subscribe to the application event stream.
    pub fn subscribe(&self) -> tokio::sync::broadcast::Receiver<CoreEvent> {
        self.bus.subscribe()
    }

    /// Graceful shutdown: flush sessions and close the database.
    pub async fn shutdown(&self) {
        self.accounts.shutdown().await;
        self.db.close().await;
        tracing::info!("core shut down");
    }
}
