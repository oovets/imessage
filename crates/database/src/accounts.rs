//! Account persistence.

use chrono::Utc;
use shared::model::{Account, AccountId};
use sqlx::{Row, SqlitePool};

use crate::DbResult;

/// Repository for the `accounts` table.
#[derive(Debug, Clone)]
pub struct AccountRepo {
    pool: SqlitePool,
}

impl AccountRepo {
    pub(crate) fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// Insert or update an account (id is the Telegram user id, so upsert).
    pub async fn upsert(&self, account: &Account) -> DbResult<()> {
        let now = Utc::now();
        sqlx::query(
            r#"
            INSERT INTO accounts (id, phone, first_name, last_name, username, authorized, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
            ON CONFLICT(id) DO UPDATE SET
                phone = excluded.phone,
                first_name = excluded.first_name,
                last_name = excluded.last_name,
                username = excluded.username,
                authorized = excluded.authorized,
                updated_at = excluded.updated_at
            "#,
        )
        .bind(account.id)
        .bind(&account.phone)
        .bind(&account.first_name)
        .bind(&account.last_name)
        .bind(&account.username)
        .bind(account.authorized)
        .bind(now)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn list(&self) -> DbResult<Vec<Account>> {
        let rows = sqlx::query(
            "SELECT id, phone, first_name, last_name, username, authorized
             FROM accounts ORDER BY created_at",
        )
        .fetch_all(&self.pool)
        .await?;
        rows.iter().map(row_to_account).collect()
    }

    pub async fn get(&self, id: AccountId) -> DbResult<Option<Account>> {
        let row = sqlx::query(
            "SELECT id, phone, first_name, last_name, username, authorized
             FROM accounts WHERE id = ?1",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        row.as_ref().map(row_to_account).transpose()
    }

    /// Flip the `authorized` flag (session revoked / logged out).
    pub async fn set_authorized(&self, id: AccountId, authorized: bool) -> DbResult<()> {
        sqlx::query("UPDATE accounts SET authorized = ?2, updated_at = ?3 WHERE id = ?1")
            .bind(id)
            .bind(authorized)
            .bind(Utc::now())
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Remove the account and (via ON DELETE CASCADE) all of its data.
    pub async fn delete(&self, id: AccountId) -> DbResult<()> {
        sqlx::query("DELETE FROM accounts WHERE id = ?1")
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }
}

fn row_to_account(row: &sqlx::sqlite::SqliteRow) -> DbResult<Account> {
    Ok(Account {
        id: row.try_get("id")?,
        phone: row.try_get("phone")?,
        first_name: row.try_get("first_name")?,
        last_name: row.try_get("last_name")?,
        username: row.try_get("username")?,
        authorized: row.try_get("authorized")?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Database;

    fn account(id: AccountId) -> Account {
        Account {
            id,
            phone: Some("+46700000000".into()),
            first_name: "Stefan".into(),
            last_name: None,
            username: Some("stefan".into()),
            authorized: true,
        }
    }

    #[tokio::test]
    async fn upsert_roundtrip_and_delete() {
        let db = Database::open_in_memory().await.expect("open");
        let repo = db.accounts();

        repo.upsert(&account(1)).await.expect("insert");
        repo.upsert(&account(1)).await.expect("update");
        assert_eq!(repo.list().await.expect("list").len(), 1);
        assert_eq!(
            repo.get(1).await.expect("get").expect("some").username,
            Some("stefan".into())
        );

        repo.set_authorized(1, false).await.expect("flag");
        assert!(!repo.get(1).await.expect("get").expect("some").authorized);

        repo.delete(1).await.expect("delete");
        assert!(repo.get(1).await.expect("get").is_none());
    }
}
