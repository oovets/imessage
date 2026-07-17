//! Interactive login flows.
//!
//! Two flows are supported:
//!
//! * **Code login** — `request_code` → `submit_code` → (optionally)
//!   `submit_password` for 2FA accounts.
//! * **QR login** (feature `qr-login`) — `qr_login_step` returns a
//!   `tg://login?token=…` URL to render as a QR code; once the update stream
//!   reports [`crate::ApiEvent::QrLoginAccepted`], calling `qr_login_step`
//!   again completes the login (or asks for the 2FA password).
//!
//! grammers has native support for the code flow; the QR flow is implemented
//! with raw `auth.exportLoginToken` / `auth.importLoginToken` calls, gated
//! behind the `qr-login` feature flag.

use chrono::{DateTime, Utc};
use grammers_client::client::{LoginToken, PasswordToken};
use grammers_client::SignInError;
use shared::model::Account;

use crate::mapping::map_account;
use crate::{TelegramClient, TgError, TgResult};

/// Opaque token linking `request_code` to `submit_code`.
pub struct CodeToken(LoginToken);

/// Opaque token for the 2FA password step.
pub struct TwoFactorToken {
    token: PasswordToken,
}

impl TwoFactorToken {
    /// The user-configured password hint, if any.
    pub fn hint(&self) -> Option<String> {
        self.token.hint().map(str::to_owned)
    }
}

/// Outcome of a code or QR step that may still require the 2FA password.
#[allow(clippy::large_enum_variant)] // constructed once per login; size is irrelevant
pub enum SignInOutcome {
    Authorized(Account),
    PasswordRequired(TwoFactorToken),
}

impl TelegramClient {
    /// Ask Telegram to send a login code to `phone`.
    pub async fn request_code(&self, phone: &str) -> TgResult<CodeToken> {
        let api_hash = self.api_hash().to_owned();
        let token = self.raw().request_login_code(phone, &api_hash).await?;
        Ok(CodeToken(token))
    }

    /// Submit the received login code.
    pub async fn submit_code(&self, token: &CodeToken, code: &str) -> TgResult<SignInOutcome> {
        match self.raw().sign_in(&token.0, code).await {
            Ok(user) => {
                self.after_login()?;
                Ok(SignInOutcome::Authorized(map_account(&user)))
            }
            Err(SignInError::PasswordRequired(password_token)) => Ok(
                SignInOutcome::PasswordRequired(TwoFactorToken {
                    token: password_token,
                }),
            ),
            Err(SignInError::InvalidCode) => {
                Err(TgError::SignIn("the login code is invalid".into()))
            }
            Err(SignInError::SignUpRequired) => Err(TgError::SignIn(
                "this phone number has no Telegram account; sign up with an official app first"
                    .into(),
            )),
            Err(SignInError::InvalidPassword(_)) => {
                Err(TgError::SignIn("invalid password".into()))
            }
            Err(SignInError::Other(e)) => Err(e.into()),
        }
    }

    /// Submit the 2FA cloud password.
    pub async fn submit_password(
        &self,
        token: TwoFactorToken,
        password: &str,
    ) -> TgResult<Account> {
        match self.raw().check_password(token.token, password).await {
            Ok(user) => {
                self.after_login()?;
                Ok(map_account(&user))
            }
            Err(SignInError::InvalidPassword(_)) => {
                Err(TgError::SignIn("invalid password".into()))
            }
            Err(SignInError::Other(e)) => Err(e.into()),
            Err(other) => Err(TgError::SignIn(other.to_string())),
        }
    }

    /// Log the account out server-side and destroy the local session.
    pub async fn sign_out(&self) -> TgResult<()> {
        let _ = self.raw().sign_out().await;
        self.session().destroy()?;
        Ok(())
    }

    /// Persist the session immediately after a successful login: the auth
    /// key just became valuable and must not be lost to a crash.
    fn after_login(&self) -> TgResult<()> {
        self.session().flush()?;
        Ok(())
    }
}

/// State machine step of the QR login flow.
#[cfg(feature = "qr-login")]
#[allow(clippy::large_enum_variant)] // constructed once per login; size is irrelevant
pub enum QrStep {
    /// Show this URL as a QR code; it expires at `expires_at` (re-call
    /// `qr_login_step` after expiry for a fresh token).
    Waiting {
        url: String,
        expires_at: DateTime<Utc>,
    },
    /// The token was accepted and the account is signed in.
    Authorized(Account),
    /// Accepted, but the account has 2FA enabled.
    PasswordRequired(TwoFactorToken),
}

#[cfg(feature = "qr-login")]
impl TelegramClient {
    /// Advance the QR login flow (raw `auth.exportLoginToken`).
    ///
    /// Call once to obtain the QR URL, then again whenever the update stream
    /// reports [`crate::ApiEvent::QrLoginAccepted`] or the token expires.
    pub async fn qr_login_step(&self) -> TgResult<QrStep> {
        use grammers_client::tl;

        let api_hash = self.api_hash().to_owned();
        let request = tl::functions::auth::ExportLoginToken {
            api_id: self.api_id(),
            api_hash: api_hash.clone(),
            except_ids: Vec::new(),
        };
        let result = match self.raw().invoke(&request).await {
            Ok(token) => token,
            Err(e) if e.is("SESSION_PASSWORD_NEEDED") => {
                return Ok(QrStep::PasswordRequired(self.fetch_password_token().await?));
            }
            Err(e) => return Err(e.into()),
        };
        self.resolve_login_token(result).await
    }

    async fn resolve_login_token(
        &self,
        token: grammers_client::tl::enums::auth::LoginToken,
    ) -> TgResult<QrStep> {
        use grammers_client::tl;

        match token {
            tl::enums::auth::LoginToken::Token(t) => Ok(QrStep::Waiting {
                url: format!(
                    "tg://login?token={}",
                    base64::Engine::encode(
                        &base64::engine::general_purpose::URL_SAFE_NO_PAD,
                        &t.token
                    )
                ),
                expires_at: crate::mapping::timestamp(t.expires),
            }),
            tl::enums::auth::LoginToken::MigrateTo(m) => {
                use grammers_session::Session as _;
                // The account lives on another DC. Route future calls (the
                // 2FA password check below, plus all post-login traffic) to
                // that DC by making it the session's home datacenter.
                let _ = self.session().set_home_dc_id(m.dc_id).await;
                let imported = match self
                    .raw()
                    .invoke_in_dc(m.dc_id, &tl::functions::auth::ImportLoginToken {
                        token: m.token,
                    })
                    .await
                {
                    Ok(imported) => imported,
                    // 2FA accounts answer the import with this: the QR itself
                    // is accepted, but the cloud password is still required.
                    Err(e) if e.is("SESSION_PASSWORD_NEEDED") => {
                        return Ok(QrStep::PasswordRequired(
                            self.fetch_password_token().await?,
                        ));
                    }
                    Err(e) => return Err(e.into()),
                };
                Box::pin(self.resolve_login_token(imported)).await
            }
            tl::enums::auth::LoginToken::Success(s) => match s.authorization {
                tl::enums::auth::Authorization::Authorization(auth) => {
                    let account = self.complete_qr_login(auth).await?;
                    Ok(QrStep::Authorized(account))
                }
                tl::enums::auth::Authorization::SignUpRequired(_) => Err(TgError::SignIn(
                    "this account requires sign-up with an official app".into(),
                )),
            },
        }
    }

    /// Replicates grammers' private `complete_login` bookkeeping for the raw
    /// QR flow: bind the self peer to the session and seed the update state,
    /// then persist the now-valuable session.
    async fn complete_qr_login(
        &self,
        auth: grammers_client::tl::types::auth::Authorization,
    ) -> TgResult<Account> {
        use grammers_client::tl;
        use grammers_session::types::{PeerAuth, PeerInfo, UpdateState, UpdatesState};
        use grammers_session::Session as _;

        let tl::enums::User::User(raw_user) = auth.user.clone() else {
            return Err(TgError::SignIn("empty user in authorization".into()));
        };

        self.session()
            .cache_peer(&PeerInfo::User {
                id: raw_user.id,
                auth: Some(
                    raw_user
                        .access_hash
                        .map(PeerAuth::from_hash)
                        .unwrap_or_default(),
                ),
                bot: Some(raw_user.bot),
                is_self: Some(true),
            })
            .await
            .map_err(|e| TgError::Session(e.to_string()))?;

        if let Ok(tl::enums::updates::State::State(state)) =
            self.raw().invoke(&tl::functions::updates::GetState {}).await
        {
            self.session()
                .set_update_state(UpdateState::All(UpdatesState {
                    pts: state.pts,
                    qts: state.qts,
                    date: state.date,
                    seq: state.seq,
                    channels: Vec::new(),
                }))
                .await
                .map_err(|e| TgError::Session(e.to_string()))?;
        }
        self.after_login()?;

        let user = grammers_client::peer::User::from_raw(&self.raw(), auth.user);
        Ok(map_account(&user))
    }

    async fn fetch_password_token(&self) -> TgResult<TwoFactorToken> {
        use grammers_client::tl;
        let password: tl::types::account::Password = self
            .raw()
            .invoke(&tl::functions::account::GetPassword {})
            .await?
            .into();
        Ok(TwoFactorToken {
            token: PasswordToken::new(password),
        })
    }
}
