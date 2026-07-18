//! # database
//!
//! SQLite persistence layer built on SQLx.
//!
//! This crate owns the **local source of truth**. The offline-first rule of
//! the application is enforced by its position in the architecture: the sync
//! engine writes network data here and the UI reads *only* from here, so the
//! app renders instantly from disk and keeps working without connectivity.
//!
//! Layout:
//!
//! * [`Database`] — pool owner, runs migrations, hands out repositories.
//! * [`accounts::AccountRepo`], [`chats::ChatRepo`], [`messages::MessageRepo`],
//!   [`users::UserRepo`] — cheap, `Clone` repository handles over the shared
//!   pool. Constructor-injected into services (`telegram-core`), which keeps
//!   business logic testable against an in-memory database.
//!
//! All SQL lives in this crate; nothing above it constructs queries.

pub mod accounts;
pub mod chats;
pub mod messages;
pub mod users;

use std::path::Path;

use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePool, SqlitePoolOptions, SqliteSynchronous};

/// Errors from the persistence layer.
#[derive(Debug, thiserror::Error)]
pub enum DbError {
    #[error("database query failed: {0}")]
    Sqlx(#[from] sqlx::Error),
    #[error("database migration failed: {0}")]
    Migrate(#[from] sqlx::migrate::MigrateError),
    #[error("stored JSON was invalid: {0}")]
    Json(#[from] serde_json::Error),
}

/// Convenience alias used across the crate.
pub type DbResult<T> = Result<T, DbError>;

/// Owner of the SQLite connection pool.
#[derive(Debug, Clone)]
pub struct Database {
    pool: SqlitePool,
}

impl Database {
    /// Open (creating if necessary) the database at `path` and run pending
    /// migrations. WAL mode keeps readers (UI queries) unblocked while the
    /// sync engine writes.
    pub async fn open(path: &Path) -> DbResult<Self> {
        if let Some(parent) = path.parent() {
            // Best-effort; the connect below reports a precise error if this fails.
            let _ = std::fs::create_dir_all(parent);
        }
        let options = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .synchronous(SqliteSynchronous::Normal)
            .foreign_keys(true);
        Self::open_with(options, 4).await
    }

    /// Open an in-memory database (tests).
    ///
    /// Uses a single connection: every pooled connection to `:memory:` would
    /// otherwise open its *own* empty database.
    pub async fn open_in_memory() -> DbResult<Self> {
        let options = SqliteConnectOptions::new()
            .in_memory(true)
            .foreign_keys(true);
        Self::open_with(options, 1).await
    }

    async fn open_with(options: SqliteConnectOptions, max_connections: u32) -> DbResult<Self> {
        let pool = SqlitePoolOptions::new()
            // Few connections: WAL allows concurrent readers, and keeping the
            // pool small avoids SQLITE_BUSY storms from competing writers.
            .max_connections(max_connections)
            .connect_with(options)
            .await?;
        sqlx::migrate!("./migrations").run(&pool).await?;
        tracing::info!("database ready");
        Ok(Self { pool })
    }

    pub fn accounts(&self) -> accounts::AccountRepo {
        accounts::AccountRepo::new(self.pool.clone())
    }

    pub fn chats(&self) -> chats::ChatRepo {
        chats::ChatRepo::new(self.pool.clone())
    }

    pub fn messages(&self) -> messages::MessageRepo {
        messages::MessageRepo::new(self.pool.clone())
    }

    pub fn users(&self) -> users::UserRepo {
        users::UserRepo::new(self.pool.clone())
    }

    /// Close the pool, flushing WAL. Called on shutdown.
    pub async fn close(&self) {
        self.pool.close().await;
    }
}
