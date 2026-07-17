//! Keychain-backed grammers session storage.
//!
//! The MTProto session (datacenter auth keys, cached peer authorizations,
//! update state) is the crown jewel of a Telegram client: whoever holds it
//! *is* the account. grammers ships file/SQLite session storages, but both
//! write the auth keys to disk in plaintext. This implementation instead
//! keeps the working state in memory and persists an encrypted-at-rest
//! snapshot into the macOS Keychain through the [`SecretStore`] abstraction.
//!
//! Peer caching happens on nearly every server response, so persisting on
//! every mutation would hammer the Keychain. Mutations only mark the session
//! *dirty*; [`KeychainSession::flush`] (called by the sync engine on a timer,
//! after login and on shutdown) writes at most one snapshot per call.

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use grammers_session::types::{DcOption, PeerId, PeerInfo, UpdateState, UpdatesState};
use grammers_session::{BoxFuture, Session, SessionData};
use shared::secrets::SecretStore;

use crate::TgError;

/// Serialized form stored in the Keychain.
///
/// `SessionData` itself does not implement serde, and JSON objects need
/// non-map containers for the `PeerId`-keyed map, so we mirror it with Vecs.
#[derive(serde::Serialize, serde::Deserialize)]
struct Snapshot {
    home_dc: i32,
    dc_options: Vec<DcOption>,
    peers: Vec<(PeerId, PeerInfo)>,
    updates_state: UpdatesState,
}

impl From<&SessionData> for Snapshot {
    fn from(data: &SessionData) -> Self {
        Self {
            home_dc: data.home_dc,
            dc_options: data.dc_options.values().cloned().collect(),
            peers: data
                .peer_infos
                .iter()
                .map(|(id, info)| (*id, info.clone()))
                .collect(),
            updates_state: data.updates_state.clone(),
        }
    }
}

impl From<Snapshot> for SessionData {
    fn from(snapshot: Snapshot) -> Self {
        // Start from the default so statically-known DC options survive even
        // if an old snapshot predates a new datacenter.
        let mut data = SessionData {
            home_dc: snapshot.home_dc,
            updates_state: snapshot.updates_state,
            ..SessionData::default()
        };
        data.dc_options
            .extend(snapshot.dc_options.into_iter().map(|o| (o.id, o)));
        data.peer_infos.extend(snapshot.peers);
        data
    }
}

/// Error type required by the grammers [`Session`] trait.
#[derive(Debug)]
pub struct SessionError(String);

impl std::fmt::Display for SessionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "session error: {}", self.0)
    }
}

impl std::error::Error for SessionError {}

/// grammers session whose durable form lives in the Keychain.
pub struct KeychainSession {
    data: Mutex<SessionData>,
    dirty: AtomicBool,
    secrets: Arc<dyn SecretStore>,
    /// Keychain item name, unique per account slot (e.g. `session-account-1`).
    secret_name: String,
}

impl KeychainSession {
    /// Load the session snapshot from the secret store, or start fresh.
    pub fn load(secrets: Arc<dyn SecretStore>, secret_name: &str) -> Result<Self, TgError> {
        let data = match secrets
            .get(secret_name)
            .map_err(|e| TgError::Session(e.to_string()))?
        {
            Some(bytes) => match serde_json::from_slice::<Snapshot>(&bytes) {
                Ok(snapshot) => SessionData::from(snapshot),
                Err(e) => {
                    // A corrupt snapshot means a fresh login is required, but
                    // must never brick startup.
                    tracing::warn!("discarding corrupt session snapshot: {e}");
                    SessionData::default()
                }
            },
            None => SessionData::default(),
        };
        Ok(Self {
            data: Mutex::new(data),
            dirty: AtomicBool::new(false),
            secrets,
            secret_name: secret_name.to_owned(),
        })
    }

    /// Whether this session has a logged-in user bound to it.
    pub fn has_self_user(&self) -> bool {
        self.data
            .lock()
            .map(|d| d.peer_infos.contains_key(&PeerId::self_user()))
            .unwrap_or(false)
    }

    /// Persist the current state to the secret store if anything changed
    /// since the last flush. Returns whether a write happened.
    pub fn flush(&self) -> Result<bool, TgError> {
        if !self.dirty.swap(false, Ordering::AcqRel) {
            return Ok(false);
        }
        let snapshot = {
            let data = self
                .data
                .lock()
                .map_err(|_| TgError::Session("poisoned session lock".into()))?;
            Snapshot::from(&*data)
        };
        let bytes =
            serde_json::to_vec(&snapshot).map_err(|e| TgError::Session(e.to_string()))?;
        self.secrets
            .set(&self.secret_name, &bytes)
            .map_err(|e| TgError::Session(e.to_string()))?;
        tracing::debug!(name = %self.secret_name, "flushed session snapshot to keychain");
        Ok(true)
    }

    /// Remove the persisted session (logout).
    pub fn destroy(&self) -> Result<(), TgError> {
        self.dirty.store(false, Ordering::Release);
        self.secrets
            .delete(&self.secret_name)
            .map_err(|e| TgError::Session(e.to_string()))
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, SessionData>, SessionError> {
        self.data
            .lock()
            .map_err(|_| SessionError("poisoned session lock".into()))
    }

    fn mark_dirty(&self) {
        self.dirty.store(true, Ordering::Release);
    }
}

impl Session for KeychainSession {
    type Error = SessionError;

    fn home_dc_id(&self) -> Result<i32, Self::Error> {
        Ok(self.lock()?.home_dc)
    }

    fn set_home_dc_id(&self, dc_id: i32) -> BoxFuture<'_, Result<(), Self::Error>> {
        Box::pin(async move {
            self.lock()?.home_dc = dc_id;
            self.mark_dirty();
            Ok(())
        })
    }

    fn dc_option(&self, dc_id: i32) -> Result<Option<DcOption>, Self::Error> {
        Ok(self.lock()?.dc_options.get(&dc_id).cloned())
    }

    fn set_dc_option(&self, dc_option: &DcOption) -> BoxFuture<'_, Result<(), Self::Error>> {
        let dc_option = dc_option.clone();
        Box::pin(async move {
            self.lock()?.dc_options.insert(dc_option.id, dc_option);
            self.mark_dirty();
            Ok(())
        })
    }

    fn peer(&self, peer: PeerId) -> BoxFuture<'_, Result<Option<PeerInfo>, Self::Error>> {
        Box::pin(async move { Ok(self.lock()?.peer_infos.get(&peer).cloned()) })
    }

    fn cache_peer(&self, peer: &PeerInfo) -> BoxFuture<'_, Result<(), Self::Error>> {
        let peer = peer.clone();
        Box::pin(async move {
            let mut data = self.lock()?;
            let id = peer_id_of(&peer);
            match data.peer_infos.get_mut(&id) {
                Some(existing) => {
                    if existing.extend_info(&peer) {
                        drop(data);
                        self.mark_dirty();
                    }
                }
                None => {
                    data.peer_infos.insert(id, peer);
                    drop(data);
                    self.mark_dirty();
                }
            }
            Ok(())
        })
    }

    fn updates_state(&self) -> BoxFuture<'_, Result<UpdatesState, Self::Error>> {
        Box::pin(async move { Ok(self.lock()?.updates_state.clone()) })
    }

    fn set_update_state(&self, update: UpdateState) -> BoxFuture<'_, Result<(), Self::Error>> {
        Box::pin(async move {
            {
                let mut data = self.lock()?;
                apply_update_state(&mut data.updates_state, update);
            }
            self.mark_dirty();
            Ok(())
        })
    }
}

/// Derive the map key for a peer info entry.
fn peer_id_of(info: &PeerInfo) -> PeerId {
    match info {
        PeerInfo::User { is_self, id, .. } => {
            if is_self.unwrap_or(false) {
                // Store the self user under both the sentinel and its real id
                // is unnecessary: grammers looks it up via the sentinel.
                PeerId::self_user()
            } else {
                PeerId::user_unchecked(*id)
            }
        }
        PeerInfo::Chat { id } => PeerId::chat_unchecked(*id),
        PeerInfo::Channel { id, .. } => PeerId::channel_unchecked(*id),
    }
}

/// Merge one update-state delta into the stored state.
fn apply_update_state(state: &mut UpdatesState, update: UpdateState) {
    match update {
        UpdateState::All(all) => *state = all,
        UpdateState::Primary { pts, date, seq } => {
            state.pts = pts;
            state.date = date;
            state.seq = seq;
        }
        UpdateState::Secondary { qts } => state.qts = qts,
        UpdateState::Channel { id, pts } => {
            match state.channels.iter_mut().find(|c| c.id == id) {
                Some(existing) => existing.pts = pts,
                None => state
                    .channels
                    .push(grammers_session::types::ChannelState { id, pts }),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct MemStore(Mutex<std::collections::HashMap<String, Vec<u8>>>);

    impl SecretStore for MemStore {
        fn set(&self, name: &str, value: &[u8]) -> Result<(), shared::secrets::SecretError> {
            self.0
                .lock()
                .expect("lock")
                .insert(name.into(), value.into());
            Ok(())
        }
        fn get(&self, name: &str) -> Result<Option<Vec<u8>>, shared::secrets::SecretError> {
            Ok(self.0.lock().expect("lock").get(name).cloned())
        }
        fn delete(&self, name: &str) -> Result<(), shared::secrets::SecretError> {
            self.0.lock().expect("lock").remove(name);
            Ok(())
        }
    }

    #[tokio::test]
    async fn snapshot_roundtrip_through_secret_store() {
        let store = Arc::new(MemStore(Mutex::new(Default::default())));

        let session = KeychainSession::load(store.clone(), "session-test").expect("load");
        session.set_home_dc_id(4).await.expect("set dc");
        session
            .cache_peer(&PeerInfo::Chat { id: 12345 })
            .await
            .expect("cache");
        assert!(session.flush().expect("flush"), "dirty session flushes");
        assert!(!session.flush().expect("flush"), "clean session skips write");

        // Reload from the same store: state must survive.
        let reloaded = KeychainSession::load(store.clone(), "session-test").expect("reload");
        assert_eq!(reloaded.home_dc_id().expect("dc"), 4);
        let peer = reloaded
            .peer(PeerId::chat_unchecked(12345))
            .await
            .expect("peer");
        assert!(matches!(peer, Some(PeerInfo::Chat { id: 12345 })));

        reloaded.destroy().expect("destroy");
        let fresh = KeychainSession::load(store, "session-test").expect("fresh");
        assert!(fresh
            .peer(PeerId::chat_unchecked(12345))
            .await
            .expect("peer")
            .is_none());
    }
}
