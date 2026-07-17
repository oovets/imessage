//! Connection lifecycle for one Telegram account.

use std::sync::Arc;

use grammers_client::client::UpdatesConfiguration;
use grammers_client::sender::{ConnectionParams, SenderPool, SenderPoolFatHandle};
use grammers_client::{Client, session::updates::UpdatesLike};
use tokio::sync::{mpsc, Mutex};
use tokio::task::JoinHandle;

use crate::session::KeychainSession;
use crate::{TgError, TgResult};

/// Everything needed to talk to Telegram for a single account.
///
/// Owns the grammers sender-pool runner task and the (single-consumer)
/// update receiver. Cheap handles ([`Client`]) are cloned out of it for
/// concurrent RPC use.
pub struct TelegramClient {
    client: Client,
    session: Arc<KeychainSession>,
    handle: SenderPoolFatHandle,
    api_hash: String,
    /// Update receiver; taken exactly once by the sync engine.
    updates_rx: Mutex<Option<mpsc::UnboundedReceiver<UpdatesLike>>>,
    /// The I/O driver task. Aborted on drop so a dropped client cannot leak
    /// its connections.
    pool_task: JoinHandle<()>,
}

impl Drop for TelegramClient {
    fn drop(&mut self) {
        self.handle.quit();
        self.pool_task.abort();
    }
}

impl TelegramClient {
    /// Build the client and start its I/O driver.
    ///
    /// No network traffic happens until the first request; connections are
    /// opened on demand by the sender pool.
    pub fn connect(
        session: Arc<KeychainSession>,
        api_id: i32,
        api_hash: &str,
        device_model: &str,
    ) -> TgResult<Self> {
        let SenderPool {
            runner,
            handle,
            updates,
        } = SenderPool::with_configuration(
            Arc::clone(&session),
            api_id,
            ConnectionParams {
                device_model: device_model.to_owned(),
                system_version: "macOS".to_owned(),
                app_version: env!("CARGO_PKG_VERSION").to_owned(),
                ..Default::default()
            },
        );
        let client = Client::new(handle.clone());
        let pool_task = tokio::spawn(async move {
            runner.run().await;
            tracing::info!("sender pool runner finished");
        });
        Ok(Self {
            client,
            session,
            handle,
            api_hash: api_hash.to_owned(),
            updates_rx: Mutex::new(Some(updates)),
            pool_task,
        })
    }

    /// Cheap RPC handle for concurrent use.
    pub(crate) fn raw(&self) -> Client {
        self.client.clone()
    }

    pub(crate) fn api_hash(&self) -> &str {
        &self.api_hash
    }

    pub(crate) fn api_id(&self) -> i32 {
        self.handle.api_id
    }

    pub fn session(&self) -> &Arc<KeychainSession> {
        &self.session
    }

    /// Whether Telegram considers this session signed in.
    pub async fn is_authorized(&self) -> TgResult<bool> {
        Ok(self.client.is_authorized().await?)
    }

    /// Build the ordered update stream. May be called only once per client;
    /// the sync engine owns the stream for the lifetime of the account.
    pub async fn take_update_stream(
        &self,
        catch_up: bool,
    ) -> TgResult<crate::updates::EventStream> {
        let receiver = self
            .updates_rx
            .lock()
            .await
            .take()
            .ok_or(TgError::Session("update stream already taken".into()))?;
        let inner = self
            .client
            .stream_updates(
                receiver,
                UpdatesConfiguration {
                    catch_up,
                    ..Default::default()
                },
            )
            .await
            .map_err(|e| TgError::Session(format!("failed to build update stream: {e}")))?;
        Ok(crate::updates::EventStream { inner })
    }

    /// Gracefully disconnect all senders.
    pub fn disconnect(&self) {
        self.handle.quit();
    }
}
