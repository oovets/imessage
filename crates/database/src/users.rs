//! Cached user profiles and presence.

use chrono::Utc;
use shared::model::{AccountId, Presence, UserId};
use sqlx::{Row, SqlitePool};

use crate::DbResult;

/// A cached Telegram user (message sender, contact, …).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CachedUser {
    pub account_id: AccountId,
    pub id: UserId,
    pub first_name: String,
    pub last_name: Option<String>,
    pub username: Option<String>,
    pub presence: Option<Presence>,
}

impl CachedUser {
    /// Display name as rendered in the UI.
    pub fn display_name(&self) -> String {
        match &self.last_name {
            Some(last) => format!("{} {}", self.first_name, last),
            None => self.first_name.clone(),
        }
    }
}

/// Repository for the `users` table.
#[derive(Debug, Clone)]
pub struct UserRepo {
    pool: SqlitePool,
}

impl UserRepo {
    pub(crate) fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    pub async fn upsert(&self, user: &CachedUser) -> DbResult<()> {
        sqlx::query(
            r#"
            INSERT INTO users (account_id, id, first_name, last_name, username, presence, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            ON CONFLICT(account_id, id) DO UPDATE SET
                first_name = excluded.first_name,
                last_name = excluded.last_name,
                username = excluded.username,
                presence = COALESCE(excluded.presence, users.presence),
                updated_at = excluded.updated_at
            "#,
        )
        .bind(user.account_id)
        .bind(user.id)
        .bind(&user.first_name)
        .bind(&user.last_name)
        .bind(&user.username)
        .bind(
            user.presence
                .as_ref()
                .map(serde_json::to_string)
                .transpose()?,
        )
        .bind(Utc::now())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn set_presence(
        &self,
        account_id: AccountId,
        user_id: UserId,
        presence: &Presence,
    ) -> DbResult<()> {
        sqlx::query(
            "UPDATE users SET presence = ?3, updated_at = ?4
             WHERE account_id = ?1 AND id = ?2",
        )
        .bind(account_id)
        .bind(user_id)
        .bind(serde_json::to_string(presence)?)
        .bind(Utc::now())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn get(&self, account_id: AccountId, user_id: UserId) -> DbResult<Option<CachedUser>> {
        let row = sqlx::query(
            "SELECT account_id, id, first_name, last_name, username, presence
             FROM users WHERE account_id = ?1 AND id = ?2",
        )
        .bind(account_id)
        .bind(user_id)
        .fetch_optional(&self.pool)
        .await?;
        row.map(|row| -> DbResult<CachedUser> {
            let presence: Option<String> = row.try_get("presence")?;
            Ok(CachedUser {
                account_id: row.try_get("account_id")?,
                id: row.try_get("id")?,
                first_name: row.try_get("first_name")?,
                last_name: row.try_get("last_name")?,
                username: row.try_get("username")?,
                presence: presence
                    .as_deref()
                    .map(serde_json::from_str::<Presence>)
                    .transpose()?,
            })
        })
        .transpose()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Database;
    use shared::model::Account;

    #[tokio::test]
    async fn presence_roundtrip() {
        let db = Database::open_in_memory().await.expect("open");
        db.accounts()
            .upsert(&Account {
                id: 1,
                phone: None,
                first_name: "t".into(),
                last_name: None,
                username: None,
                authorized: true,
            })
            .await
            .expect("account");
        let repo = db.users();
        repo.upsert(&CachedUser {
            account_id: 1,
            id: 7,
            first_name: "Alice".into(),
            last_name: Some("A".into()),
            username: None,
            presence: None,
        })
        .await
        .expect("upsert");

        repo.set_presence(1, 7, &Presence::Online).await.expect("presence");
        let user = repo.get(1, 7).await.expect("get").expect("some");
        assert_eq!(user.presence, Some(Presence::Online));
        assert_eq!(user.display_name(), "Alice A");
    }
}
