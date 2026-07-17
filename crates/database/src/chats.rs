//! Chat list persistence.

use chrono::{DateTime, Utc};
use shared::model::{AccountId, Chat, ChatId, ChatKind};
use sqlx::{Row, SqlitePool};

use crate::DbResult;

/// Repository for the `chats` table.
#[derive(Debug, Clone)]
pub struct ChatRepo {
    pool: SqlitePool,
}

impl ChatRepo {
    pub(crate) fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    pub async fn upsert(&self, chat: &Chat) -> DbResult<()> {
        sqlx::query(
            r#"
            INSERT INTO chats (account_id, id, kind, title, username, unread_count,
                               pinned, last_message_at, last_message_preview, avatar_key, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
            ON CONFLICT(account_id, id) DO UPDATE SET
                kind = excluded.kind,
                title = excluded.title,
                username = excluded.username,
                unread_count = excluded.unread_count,
                pinned = excluded.pinned,
                last_message_at = excluded.last_message_at,
                last_message_preview = excluded.last_message_preview,
                -- Keep a known avatar key if a later update omits it.
                avatar_key = COALESCE(excluded.avatar_key, chats.avatar_key),
                updated_at = excluded.updated_at
            "#,
        )
        .bind(chat.account_id)
        .bind(chat.id)
        .bind(kind_to_str(chat.kind))
        .bind(&chat.title)
        .bind(&chat.username)
        .bind(chat.unread_count)
        .bind(chat.pinned)
        .bind(chat.last_message_at)
        .bind(&chat.last_message_preview)
        .bind(&chat.avatar_key)
        .bind(Utc::now())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Chat list for one account, pinned chats first, then by recency.
    pub async fn list(&self, account_id: AccountId) -> DbResult<Vec<Chat>> {
        let rows = sqlx::query(
            "SELECT account_id, id, kind, title, username, unread_count, pinned,
                    last_message_at, last_message_preview, avatar_key
             FROM chats WHERE account_id = ?1
             ORDER BY pinned DESC, last_message_at DESC NULLS LAST",
        )
        .bind(account_id)
        .fetch_all(&self.pool)
        .await?;
        rows.iter().map(row_to_chat).collect()
    }

    pub async fn get(&self, account_id: AccountId, chat_id: ChatId) -> DbResult<Option<Chat>> {
        let row = sqlx::query(
            "SELECT account_id, id, kind, title, username, unread_count, pinned,
                    last_message_at, last_message_preview, avatar_key
             FROM chats WHERE account_id = ?1 AND id = ?2",
        )
        .bind(account_id)
        .bind(chat_id)
        .fetch_optional(&self.pool)
        .await?;
        row.as_ref().map(row_to_chat).transpose()
    }

    /// Update the denormalized chat-list preview after a new/edited message.
    pub async fn touch_last_message(
        &self,
        account_id: AccountId,
        chat_id: ChatId,
        at: DateTime<Utc>,
        preview: &str,
    ) -> DbResult<()> {
        sqlx::query(
            "UPDATE chats
             SET last_message_at = ?3, last_message_preview = ?4, updated_at = ?5
             WHERE account_id = ?1 AND id = ?2
               AND (last_message_at IS NULL OR last_message_at <= ?3)",
        )
        .bind(account_id)
        .bind(chat_id)
        .bind(at)
        .bind(preview)
        .bind(Utc::now())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn set_unread_count(
        &self,
        account_id: AccountId,
        chat_id: ChatId,
        unread: i32,
    ) -> DbResult<()> {
        sqlx::query(
            "UPDATE chats SET unread_count = ?3, updated_at = ?4
             WHERE account_id = ?1 AND id = ?2",
        )
        .bind(account_id)
        .bind(chat_id)
        .bind(unread)
        .bind(Utc::now())
        .execute(&self.pool)
        .await?;
        Ok(())
    }
}

fn kind_to_str(kind: ChatKind) -> &'static str {
    match kind {
        ChatKind::Private => "private",
        ChatKind::Group => "group",
        ChatKind::Channel => "channel",
    }
}

fn kind_from_str(s: &str) -> ChatKind {
    match s {
        "group" => ChatKind::Group,
        "channel" => ChatKind::Channel,
        _ => ChatKind::Private,
    }
}

fn row_to_chat(row: &sqlx::sqlite::SqliteRow) -> DbResult<Chat> {
    let kind: String = row.try_get("kind")?;
    Ok(Chat {
        account_id: row.try_get("account_id")?,
        id: row.try_get("id")?,
        kind: kind_from_str(&kind),
        title: row.try_get("title")?,
        username: row.try_get("username")?,
        unread_count: row.try_get("unread_count")?,
        pinned: row.try_get("pinned")?,
        last_message_at: row.try_get("last_message_at")?,
        last_message_preview: row.try_get("last_message_preview")?,
        avatar_key: row.try_get("avatar_key")?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Database;
    use shared::model::Account;

    async fn db_with_account() -> Database {
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
        db
    }

    fn chat(id: ChatId, pinned: bool) -> Chat {
        Chat {
            account_id: 1,
            id,
            kind: ChatKind::Private,
            title: format!("chat {id}"),
            username: None,
            unread_count: 0,
            pinned,
            last_message_at: None,
            last_message_preview: None,
            avatar_key: None,
        }
    }

    #[tokio::test]
    async fn list_orders_pinned_then_recent() {
        let db = db_with_account().await;
        let repo = db.chats();
        repo.upsert(&chat(10, false)).await.expect("upsert");
        repo.upsert(&chat(20, true)).await.expect("upsert");
        repo.upsert(&chat(30, false)).await.expect("upsert");

        let t1 = Utc::now();
        repo.touch_last_message(1, 30, t1, "newest").await.expect("touch");
        repo.touch_last_message(1, 10, t1 - chrono::Duration::seconds(60), "older")
            .await
            .expect("touch");

        let list = repo.list(1).await.expect("list");
        let ids: Vec<ChatId> = list.iter().map(|c| c.id).collect();
        assert_eq!(ids, vec![20, 30, 10]);
        assert_eq!(list[1].last_message_preview.as_deref(), Some("newest"));
    }

    #[tokio::test]
    async fn touch_never_moves_backwards() {
        let db = db_with_account().await;
        let repo = db.chats();
        repo.upsert(&chat(1, false)).await.expect("upsert");
        let now = Utc::now();
        repo.touch_last_message(1, 1, now, "new").await.expect("touch");
        // A backfilled old message must not overwrite a newer preview.
        repo.touch_last_message(1, 1, now - chrono::Duration::hours(1), "old")
            .await
            .expect("touch");
        let chat = repo.get(1, 1).await.expect("get").expect("some");
        assert_eq!(chat.last_message_preview.as_deref(), Some("new"));
    }
}
