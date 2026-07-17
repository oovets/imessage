//! Multi-account management and interactive login flows.
//!
//! Each logged-in account gets an [`AccountRuntime`]: a connected
//! [`TelegramClient`] plus a background sync task. Login flows run on a
//! *pending* slot (session secret `session-pending`) and are promoted to a
//! real account slot (`session-<account id>`) once Telegram tells us who
//! logged in.

use std::collections::HashMap;
use std::sync::Arc;

use database::Database;
use shared::model::{Account, AccountId, LoginStage};
use shared::secrets::SecretStore;
use shared::{AppConfig, CoreEvent};
use telegram_api::auth::SignInOutcome;
use telegram_api::session::KeychainSession;
use telegram_api::TelegramClient;
use tokio::task::JoinHandle;

use crate::{bus::EventBus, CoreError, CoreResult};

const PENDING_SECRET: &str = "session-pending";

fn session_secret_name(account_id: AccountId) -> String {
    format!("session-{account_id}")
}

struct AccountRuntime {
    client: Arc<TelegramClient>,
    sync_task: JoinHandle<()>,
}

struct PendingLogin {
    client: Arc<TelegramClient>,
    code_token: Option<telegram_api::auth::CodeToken>,
    two_factor: Option<telegram_api::auth::TwoFactorToken>,
    /// QR flows run a background watcher (token refresh + accept detection).
    qr_task: Option<JoinHandle<()>>,
}

struct Inner {
    config: AppConfig,
    db: Database,
    bus: EventBus,
    secrets: Arc<dyn SecretStore>,
    runtimes: tokio::sync::RwLock<HashMap<AccountId, AccountRuntime>>,
    pending: tokio::sync::Mutex<Option<PendingLogin>>,
}

/// Owner of all per-account runtimes. Cheap to clone.
#[derive(Clone)]
pub struct AccountManager {
    inner: Arc<Inner>,
}

impl AccountManager {
    pub fn new(
        config: AppConfig,
        db: Database,
        bus: EventBus,
        secrets: Arc<dyn SecretStore>,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                config,
                db,
                bus,
                secrets,
                runtimes: Default::default(),
                pending: Default::default(),
            }),
        }
    }

    /// Reconnect every account with a stored session (called at startup).
    pub async fn resume_all(&self) -> CoreResult<()> {
        for account in self.inner.db.accounts().list().await? {
            if account.authorized {
                if let Err(e) = self.inner.clone().start_runtime(account.id).await {
                    // One broken account must not prevent the app (and the
                    // other accounts) from starting.
                    tracing::error!(account = account.id, "failed to resume account: {e}");
                }
            }
        }
        Ok(())
    }

    pub async fn list(&self) -> CoreResult<Vec<Account>> {
        Ok(self.inner.db.accounts().list().await?)
    }

    /// The connected client for an account (used by the service layer).
    pub async fn client(&self, account_id: AccountId) -> CoreResult<Arc<TelegramClient>> {
        self.inner
            .runtimes
            .read()
            .await
            .get(&account_id)
            .map(|r| Arc::clone(&r.client))
            .ok_or(CoreError::UnknownAccount(account_id))
    }

    // ----- code login ------------------------------------------------------

    /// Start a phone-number login: sends the code and emits `CodeSent`.
    pub async fn begin_code_login(&self, phone: &str) -> CoreResult<()> {
        let client = self.inner.clone().fresh_pending_client().await?;
        let token = client.request_code(phone).await?;
        *self.inner.pending.lock().await = Some(PendingLogin {
            client,
            code_token: Some(token),
            two_factor: None,
            qr_task: None,
        });
        self.inner.bus.publish(CoreEvent::Login {
            account_id: None,
            stage: LoginStage::CodeSent,
        });
        Ok(())
    }

    /// Submit the login code the user received.
    pub async fn submit_code(&self, code: &str) -> CoreResult<()> {
        let mut guard = self.inner.pending.lock().await;
        let pending = guard.as_mut().ok_or(CoreError::NoPendingLogin)?;
        let token = pending.code_token.take().ok_or(CoreError::NoPendingLogin)?;
        match pending.client.submit_code(&token, code).await {
            Ok(SignInOutcome::Authorized(account)) => {
                let pending = guard.take().ok_or(CoreError::NoPendingLogin)?;
                drop(guard);
                self.inner.clone().finalize_login(account, pending).await
            }
            Ok(SignInOutcome::PasswordRequired(two_factor)) => {
                let hint = two_factor.hint();
                pending.two_factor = Some(two_factor);
                self.inner.bus.publish(CoreEvent::Login {
                    account_id: None,
                    stage: LoginStage::PasswordRequired { hint },
                });
                Ok(())
            }
            Err(e) => {
                // Allow retrying the code without restarting the whole flow.
                pending.code_token = Some(token);
                Err(e.into())
            }
        }
    }

    /// Submit the 2FA cloud password.
    pub async fn submit_password(&self, password: &str) -> CoreResult<()> {
        let mut guard = self.inner.pending.lock().await;
        let pending = guard.as_mut().ok_or(CoreError::NoPendingLogin)?;
        let token = pending.two_factor.take().ok_or(CoreError::NoPendingLogin)?;
        match pending.client.submit_password(token, password).await {
            Ok(account) => {
                let pending = guard.take().ok_or(CoreError::NoPendingLogin)?;
                drop(guard);
                self.inner.clone().finalize_login(account, pending).await
            }
            Err(e) => Err(e.into()),
        }
    }

    // ----- QR login --------------------------------------------------------

    /// Start a QR login. Emits `QrCode` stages (with refreshed tokens) until
    /// the code is scanned, then `Complete` or `PasswordRequired`.
    #[cfg(feature = "qr-login")]
    pub async fn begin_qr_login(&self) -> CoreResult<()> {
        let client = self.inner.clone().fresh_pending_client().await?;
        let inner = self.inner.clone();
        let qr_client = Arc::clone(&client);
        let qr_task = tokio::spawn(async move {
            if let Err(e) = inner.clone().run_qr_flow(qr_client).await {
                tracing::warn!("qr login flow ended: {e}");
            }
        });
        *self.inner.pending.lock().await = Some(PendingLogin {
            client,
            code_token: None,
            two_factor: None,
            qr_task: Some(qr_task),
        });
        Ok(())
    }

    // ----- lifecycle -------------------------------------------------------

    /// Log an account out (server-side revoke + local session destruction).
    pub async fn sign_out(&self, account_id: AccountId) -> CoreResult<()> {
        if let Some(runtime) = self.inner.runtimes.write().await.remove(&account_id) {
            runtime.sync_task.abort();
            let _ = runtime.client.sign_out().await;
            runtime.client.disconnect();
        } else {
            // No live runtime; still remove the stored session.
            self.inner
                .secrets
                .delete(&session_secret_name(account_id))
                .map_err(|e| telegram_api::TgError::Session(e.to_string()))?;
        }
        self.inner.db.accounts().set_authorized(account_id, false).await?;
        self.inner.bus.publish(CoreEvent::LoggedOut { account_id });
        Ok(())
    }

    /// Flush sessions and stop all sync tasks.
    pub async fn shutdown(&self) {
        let mut runtimes = self.inner.runtimes.write().await;
        for (id, runtime) in runtimes.drain() {
            if let Err(e) = runtime.client.session().flush() {
                tracing::warn!(account = id, "session flush on shutdown failed: {e}");
            }
            runtime.sync_task.abort();
            runtime.client.disconnect();
        }
        if let Some(pending) = self.inner.pending.lock().await.take() {
            if let Some(task) = pending.qr_task {
                task.abort();
            }
        }
    }
}

impl Inner {
    /// Create a pending-slot client, discarding any previous pending state.
    async fn fresh_pending_client(self: Arc<Self>) -> CoreResult<Arc<TelegramClient>> {
        if let Some(previous) = self.pending.lock().await.take() {
            if let Some(task) = previous.qr_task {
                task.abort();
            }
            previous.client.disconnect();
        }
        self.secrets
            .delete(PENDING_SECRET)
            .map_err(|e| telegram_api::TgError::Session(e.to_string()))?;
        let session = Arc::new(
            KeychainSession::load(Arc::clone(&self.secrets), PENDING_SECRET)
                .map_err(CoreError::Telegram)?,
        );
        let client = TelegramClient::connect(
            session,
            self.config.telegram.api_id,
            &self.config.telegram.api_hash,
            &self.config.telegram.device_model,
        )?;
        Ok(Arc::new(client))
    }

    /// Promote a finished pending login to a full account runtime.
    async fn finalize_login(
        self: Arc<Self>,
        account: Account,
        pending: PendingLogin,
    ) -> CoreResult<()> {
        if let Some(task) = pending.qr_task {
            task.abort();
        }
        // Move the session secret from the pending slot to the account slot.
        pending
            .client
            .session()
            .flush()
            .map_err(CoreError::Telegram)?;
        let map_err = |e: shared::secrets::SecretError| {
            CoreError::Telegram(telegram_api::TgError::Session(e.to_string()))
        };
        let bytes = self
            .secrets
            .get(PENDING_SECRET)
            .map_err(map_err)?
            .unwrap_or_default();
        self.secrets
            .set(&session_secret_name(account.id), &bytes)
            .map_err(map_err)?;
        self.secrets.delete(PENDING_SECRET).map_err(map_err)?;
        pending.client.disconnect();
        drop(pending.client);

        self.db.accounts().upsert(&account).await?;
        self.clone().start_runtime(account.id).await?;
        self.bus.publish(CoreEvent::Login {
            account_id: Some(account.id),
            stage: LoginStage::Complete { account },
        });
        Ok(())
    }

    /// Connect an account's client and spawn its sync task.
    async fn start_runtime(self: Arc<Self>, account_id: AccountId) -> CoreResult<()> {
        let session = Arc::new(
            KeychainSession::load(
                Arc::clone(&self.secrets),
                &session_secret_name(account_id),
            )
            .map_err(CoreError::Telegram)?,
        );
        let client = Arc::new(TelegramClient::connect(
            session,
            self.config.telegram.api_id,
            &self.config.telegram.api_hash,
            &self.config.telegram.device_model,
        )?);

        let sync_task = tokio::spawn(crate::sync::run(
            account_id,
            Arc::clone(&client),
            self.db.clone(),
            self.bus.clone(),
            self.config.clone(),
            self.clone().logged_out_callback(account_id),
        ));

        self.runtimes
            .write()
            .await
            .insert(account_id, AccountRuntime { client, sync_task });
        Ok(())
    }

    /// Callback the sync engine fires when Telegram revokes the session.
    fn logged_out_callback(
        self: Arc<Self>,
        account_id: AccountId,
    ) -> impl FnOnce() + Send + 'static {
        move || {
            tokio::spawn(async move {
                let _ = self
                    .secrets
                    .delete(&session_secret_name(account_id));
                if let Err(e) = self.db.accounts().set_authorized(account_id, false).await {
                    tracing::error!("failed to record logout: {e}");
                }
                self.runtimes.write().await.remove(&account_id);
                self.bus.publish(CoreEvent::LoggedOut { account_id });
            });
        }
    }

    /// Drive the QR flow: refresh tokens on expiry, finish on acceptance.
    #[cfg(feature = "qr-login")]
    async fn run_qr_flow(self: Arc<Self>, client: Arc<TelegramClient>) -> CoreResult<()> {
        use telegram_api::auth::QrStep;
        use telegram_api::ApiEvent;

        // Pre-auth update stream: only used to detect the QR acceptance.
        let mut stream = client.take_update_stream(false).await?;
        loop {
            match client.qr_login_step().await? {
                QrStep::Waiting { url, expires_at } => {
                    self.bus.publish(CoreEvent::Login {
                        account_id: None,
                        stage: LoginStage::QrCode { url, expires_at },
                    });
                    // Wait until scanned or expired, whichever comes first.
                    let ttl = (expires_at - chrono::Utc::now())
                        .to_std()
                        .unwrap_or(std::time::Duration::from_secs(30));
                    let accepted = tokio::time::timeout(ttl, async {
                        loop {
                            match stream.next(0).await {
                                Ok(ApiEvent::QrLoginAccepted) => break true,
                                Ok(_) => continue,
                                Err(e) => {
                                    tracing::debug!("qr update stream error: {e}");
                                    break false;
                                }
                            }
                        }
                    })
                    .await
                    .unwrap_or(false);
                    if !accepted {
                        continue; // token expired → export a fresh one
                    }
                    // Loop around: the next qr_login_step returns Success.
                }
                QrStep::Authorized(account) => {
                    let mut pending = self
                        .pending
                        .lock()
                        .await
                        .take()
                        .ok_or(CoreError::NoPendingLogin)?;
                    // This code *is* the qr task: clearing the handle stops
                    // finalize_login from aborting itself mid-flight.
                    pending.qr_task = None;
                    return self.clone().finalize_login(account, pending).await;
                }
                QrStep::PasswordRequired(two_factor) => {
                    let hint = two_factor.hint();
                    if let Some(pending) = self.pending.lock().await.as_mut() {
                        pending.two_factor = Some(two_factor);
                    }
                    self.bus.publish(CoreEvent::Login {
                        account_id: None,
                        stage: LoginStage::PasswordRequired { hint },
                    });
                    return Ok(());
                }
            }
        }
    }
}
