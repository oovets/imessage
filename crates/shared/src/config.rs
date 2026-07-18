//! Layered, typed configuration.
//!
//! Precedence (lowest → highest):
//!
//! 1. Compiled-in defaults ([`AppConfig::default`])
//! 2. `config/default.toml` next to the executable / repo root (dev)
//! 3. `<app data dir>/config.toml` (user overrides)
//! 4. Environment variables `TG_API_ID` / `TG_API_HASH` (secrets in CI/dev)
//!
//! The API id/hash identify the *application* towards Telegram (obtained from
//! <https://my.telegram.org>); they are not user secrets, but we still allow
//! supplying them via env so they never need to be committed.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Errors raised while loading configuration.
#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("failed to read config file {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("failed to parse config file {path}: {source}")]
    Parse {
        path: PathBuf,
        #[source]
        source: toml::de::Error,
    },
    #[error("could not determine platform application directories")]
    NoProjectDirs,
    #[error(
        "telegram.api_id / telegram.api_hash are not configured; \
         set them in config.toml or via TG_API_ID / TG_API_HASH"
    )]
    MissingApiCredentials,
}

/// Telegram application identity.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct TelegramConfig {
    /// API id from <https://my.telegram.org>. `0` means "not configured".
    pub api_id: i32,
    pub api_hash: String,
    /// Device model reported to Telegram (shows up in "Active sessions").
    pub device_model: String,
    /// Catch-up on missed updates after reconnecting.
    pub catch_up: bool,
}

/// Storage locations. All paths are absolute after [`AppConfig::load`].
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct StorageConfig {
    /// Directory for the SQLite database. Empty = platform data dir.
    pub data_dir: PathBuf,
    /// Directory for the encrypted media cache. Empty = platform cache dir.
    pub cache_dir: PathBuf,
    /// Soft limit for the media cache; least-recently-used blobs are evicted
    /// beyond this size.
    pub cache_max_bytes: u64,
}

/// Logging configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct LogConfig {
    /// `tracing_subscriber::EnvFilter` directive, e.g. `info,telegram_core=debug`.
    pub filter: String,
    /// Also write a rolling log file into the data directory.
    pub file: bool,
}

impl Default for LogConfig {
    fn default() -> Self {
        Self {
            filter: "info".to_owned(),
            file: true,
        }
    }
}

/// Synchronization tuning.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct SyncConfig {
    /// How many dialogs to fetch when (re)building the chat list.
    pub dialogs_page_size: usize,
    /// How many recent messages to backfill per chat on first open.
    pub history_page_size: usize,
    /// Initial reconnect backoff in seconds (doubles up to `backoff_max_secs`).
    pub backoff_initial_secs: u64,
    pub backoff_max_secs: u64,
}

impl Default for SyncConfig {
    fn default() -> Self {
        Self {
            dialogs_page_size: 100,
            history_page_size: 50,
            backoff_initial_secs: 2,
            backoff_max_secs: 300,
        }
    }
}

/// Root configuration object.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct AppConfig {
    pub telegram: TelegramConfig,
    pub storage: StorageConfig,
    pub log: LogConfig,
    pub sync: SyncConfig,
}

impl AppConfig {
    /// Qualified app identifier used for platform directories and Keychain
    /// service names.
    pub const APP_ID: (&'static str, &'static str, &'static str) =
        ("dev", "stefan", "TelegramGui");

    /// Load configuration with full layering (see module docs).
    ///
    /// `dev_config` is an optional path to a repo-local `default.toml`,
    /// typically `config/default.toml` during development.
    pub fn load(dev_config: Option<&Path>) -> Result<Self, ConfigError> {
        let mut cfg = AppConfig::default();

        if let Some(path) = dev_config {
            if path.exists() {
                cfg.merge_file(path)?;
            }
        }

        let dirs = directories::ProjectDirs::from(
            Self::APP_ID.0,
            Self::APP_ID.1,
            Self::APP_ID.2,
        )
        .ok_or(ConfigError::NoProjectDirs)?;

        let user_config = dirs.config_dir().join("config.toml");
        if user_config.exists() {
            cfg.merge_file(&user_config)?;
        }

        // Environment overrides (highest precedence).
        if let Ok(id) = std::env::var("TG_API_ID") {
            if let Ok(id) = id.trim().parse::<i32>() {
                cfg.telegram.api_id = id;
            }
        }
        if let Ok(hash) = std::env::var("TG_API_HASH") {
            cfg.telegram.api_hash = hash.trim().to_owned();
        }

        // Resolve empty paths to platform defaults.
        if cfg.storage.data_dir.as_os_str().is_empty() {
            cfg.storage.data_dir = dirs.data_dir().to_path_buf();
        }
        if cfg.storage.cache_dir.as_os_str().is_empty() {
            cfg.storage.cache_dir = dirs.cache_dir().to_path_buf();
        }
        if cfg.storage.cache_max_bytes == 0 {
            cfg.storage.cache_max_bytes = 2 * 1024 * 1024 * 1024; // 2 GiB
        }
        if cfg.telegram.device_model.is_empty() {
            cfg.telegram.device_model = "TelegramGui (macOS)".to_owned();
        }

        Ok(cfg)
    }

    /// Fail fast if the Telegram application credentials are missing.
    pub fn require_api_credentials(&self) -> Result<(), ConfigError> {
        if self.telegram.api_id == 0 || self.telegram.api_hash.is_empty() {
            return Err(ConfigError::MissingApiCredentials);
        }
        Ok(())
    }

    /// Merge a TOML file over the current values. Only keys present in the
    /// file are overridden (serde `default` + full re-deserialize of a merged
    /// TOML value keeps this simple and predictable).
    fn merge_file(&mut self, path: &Path) -> Result<(), ConfigError> {
        let text = std::fs::read_to_string(path).map_err(|source| ConfigError::Io {
            path: path.to_path_buf(),
            source,
        })?;
        let overlay: toml::Value = toml::from_str(&text).map_err(|source| ConfigError::Parse {
            path: path.to_path_buf(),
            source,
        })?;
        let base = toml::Value::try_from(&*self).unwrap_or(toml::Value::Table(Default::default()));
        let merged = merge_toml(base, overlay);
        *self = merged.try_into().map_err(|source| ConfigError::Parse {
            path: path.to_path_buf(),
            source,
        })?;
        Ok(())
    }
}

/// Recursively merge `overlay` on top of `base` (tables merge, scalars replace).
fn merge_toml(base: toml::Value, overlay: toml::Value) -> toml::Value {
    match (base, overlay) {
        (toml::Value::Table(mut base), toml::Value::Table(overlay)) => {
            for (key, value) in overlay {
                let merged = match base.remove(&key) {
                    Some(existing) => merge_toml(existing, value),
                    None => value,
                };
                base.insert(key, merged);
            }
            toml::Value::Table(base)
        }
        (_, overlay) => overlay,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_prefers_overlay_scalars_and_merges_tables() {
        let base: toml::Value = toml::from_str(
            r#"
            [telegram]
            api_id = 1
            api_hash = "aaa"
            "#,
        )
        .expect("valid toml");
        let overlay: toml::Value = toml::from_str(
            r#"
            [telegram]
            api_id = 2
            "#,
        )
        .expect("valid toml");
        let merged = merge_toml(base, overlay);
        let telegram = merged.get("telegram").expect("table kept");
        assert_eq!(telegram.get("api_id").and_then(|v| v.as_integer()), Some(2));
        assert_eq!(
            telegram.get("api_hash").and_then(|v| v.as_str()),
            Some("aaa")
        );
    }

    #[test]
    fn default_config_reports_missing_credentials() {
        let cfg = AppConfig::default();
        assert!(cfg.require_api_credentials().is_err());
    }
}
