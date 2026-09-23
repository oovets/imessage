//! Chat list persistence.

use chrono::{DateTime, Utc};
use shared::model::{resolve_mute, AccountId, Chat, ChatId, ChatKind, MuteDefaults};
use sqlx::{Row, SqlitePool};

use crate::DbResult;

/// The columns [`row_to_chat`] reads: the chat plus its own raw mute and the
/// account default for its kind, which `row_to_chat` resolves to
/// [`Chat::muted_until`]. Callers append the WHERE / ORDER BY.
const SELECT_CHAT: &str = "SELECT c.account_id, c.id, c.kind, c.title, c.username, c.unread_count,
            c.pinned, c.last_message_at, c.last_message_preview, c.avatar_key,
            c.mute_until AS own_mute_until, d.mute_until AS default_mute_until
     FROM chats c
     LEFT JOIN mute_defaults d ON d.account_id = c.account_id AND d.kind = c.kind";

/// Repository for the `chats` table.
#[derive(Debug, Clone)]
pub struct ChatRepo {
    pool: SqlitePool,
}

impl ChatRepo {
    pub(crate) fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// Insert or update a chat's metadata.
    ///
    /// Leaves the stored mute alone: [`Chat::muted_until`] is the resolved
    /// value, not Telegram's raw setting, so that is written separately with
    /// [`ChatRepo::set_mute_until`].
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
        let sql = format!(
            "{SELECT_CHAT} WHERE c.account_id = ?1
             ORDER BY c.pinned DESC, c.last_message_at DESC NULLS LAST"
        );
        let rows = sqlx::query(&sql)
            .bind(account_id)
            .fetch_all(&self.pool)
            .await?;
        rows.iter().map(row_to_chat).collect()
    }

    pub async fn get(&self, account_id: AccountId, chat_id: ChatId) -> DbResult<Option<Chat>> {
        let sql = format!("{SELECT_CHAT} WHERE c.account_id = ?1 AND c.id = ?2");
        let row = sqlx::query(&sql)
            .bind(account_id)
            .bind(chat_id)
            .fetch_optional(&self.pool)
            .await?;
        row.as_ref().map(row_to_chat).transpose()
    }

    /// Chats of `kind` without a mute setting of their own: the ones a change
    /// to that kind's account default affects.
    pub async fn list_following_mute_default(
        &self,
        account_id: AccountId,
        kind: ChatKind,
    ) -> DbResult<Vec<Chat>> {
        let sql = format!(
            "{SELECT_CHAT} WHERE c.account_id = ?1 AND c.kind = ?2 AND c.mute_until IS NULL
             ORDER BY c.pinned DESC, c.last_message_at DESC NULLS LAST"
        );
        let rows = sqlx::query(&sql)
            .bind(account_id)
            .bind(kind_to_str(kind))
            .fetch_all(&self.pool)
            .await?;
        rows.iter().map(row_to_chat).collect()
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

    /// Store the chat's own raw `mute_until` (unix seconds), exactly as
    /// Telegram reports it: `None` = follow the account default for its kind.
    pub async fn set_mute_until(
        &self,
        account_id: AccountId,
        chat_id: ChatId,
        mute_until: Option<i32>,
    ) -> DbResult<()> {
        sqlx::query(
            "UPDATE chats SET mute_until = ?3, updated_at = ?4
             WHERE account_id = ?1 AND id = ?2",
        )
        .bind(account_id)
        .bind(chat_id)
        .bind(mute_until)
        .bind(Utc::now())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// The account's notification defaults per chat kind (all unmuted until
    /// a sync has stored them).
    pub async fn mute_defaults(&self, account_id: AccountId) -> DbResult<MuteDefaults> {
        let rows = sqlx::query("SELECT kind, mute_until FROM mute_defaults WHERE account_id = ?1")
            .bind(account_id)
            .fetch_all(&self.pool)
            .await?;
        let mut defaults = MuteDefaults::default();
        for row in &rows {
            let kind: String = row.try_get("kind")?;
            let mute_until: Option<i32> = row.try_get("mute_until")?;
            match kind_from_str(&kind) {
                ChatKind::Private => defaults.private = mute_until,
                ChatKind::Group => defaults.group = mute_until,
                ChatKind::Channel => defaults.channel = mute_until,
            }
        }
        Ok(defaults)
    }

    /// Store the account default for one chat kind.
    pub async fn set_mute_default(
        &self,
        account_id: AccountId,
        kind: ChatKind,
        mute_until: Option<i32>,
    ) -> DbResult<()> {
        sqlx::query(
            r#"
            INSERT INTO mute_defaults (account_id, kind, mute_until, updated_at)
            VALUES (?1, ?2, ?3, ?4)
            ON CONFLICT(account_id, kind) DO UPDATE SET
                mute_until = excluded.mute_until,
                updated_at = excluded.updated_at
            "#,
        )
        .bind(account_id)
        .bind(kind_to_str(kind))
        .bind(mute_until)
        .bind(Utc::now())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Store all three account defaults (after fetching them from Telegram).
    pub async fn set_mute_defaults(
        &self,
        account_id: AccountId,
        defaults: &MuteDefaults,
    ) -> DbResult<()> {
        for kind in [ChatKind::Private, ChatKind::Group, ChatKind::Channel] {
            self.set_mute_default(account_id, kind, defaults.for_kind(kind))
                .await?;
        }
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
        muted_until: resolve_mute(
            row.try_get("own_mute_until")?,
            row.try_get("default_mute_until")?,
            Utc::now(),
        ),
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
            muted_until: None,
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

    fn secs_from_now(secs: i64) -> i32 {
        (Utc::now().timestamp() + secs) as i32
    }

    fn at(secs: i32) -> Option<DateTime<Utc>> {
        DateTime::from_timestamp(i64::from(secs), 0)
    }

    #[tokio::test]
    async fn mute_reads_back_resolved() {
        let db = db_with_account().await;
        let repo = db.chats();
        let group = Chat {
            kind: ChatKind::Group,
            ..chat(3, false)
        };
        for c in [chat(1, false), chat(2, false), group] {
            repo.upsert(&c).await.expect("upsert");
        }
        let in_an_hour = secs_from_now(3_600);
        repo.set_mute_defaults(
            1,
            &MuteDefaults {
                private: Some(i32::MAX),
                ..MuteDefaults::default()
            },
        )
        .await
        .expect("defaults");
        // 1 follows the muted private default; 2 was unmuted explicitly (0);
        // 3 is a group (unmuted default) muted for an hour on its own.
        repo.set_mute_until(1, 2, Some(0)).await.expect("mute");
        repo.set_mute_until(1, 3, Some(in_an_hour))
            .await
            .expect("mute");

        let muted = |id: ChatId, list: &[Chat]| {
            list.iter()
                .find(|c| c.id == id)
                .expect("listed")
                .muted_until
        };
        let list = repo.list(1).await.expect("list");
        assert_eq!(muted(1, &list), at(i32::MAX));
        assert_eq!(muted(2, &list), None);
        assert_eq!(muted(3, &list), at(in_an_hour));
        let got = repo.get(1, 3).await.expect("get").expect("some");
        assert_eq!(got.muted_until, at(in_an_hour));

        // A metadata upsert (dialog sync, carrying the resolved value) must
        // not overwrite the raw setting.
        repo.upsert(&chat(2, true)).await.expect("upsert");
        assert_eq!(
            repo.get(1, 2)
                .await
                .expect("get")
                .expect("some")
                .muted_until,
            None
        );
        repo.upsert(&chat(1, true)).await.expect("upsert");
        assert_eq!(
            repo.get(1, 1)
                .await
                .expect("get")
                .expect("some")
                .muted_until,
            at(i32::MAX)
        );
    }

    #[tokio::test]
    async fn lapsed_or_cleared_mute_reads_back_unmuted() {
        let db = db_with_account().await;
        let repo = db.chats();
        repo.upsert(&chat(1, false)).await.expect("upsert");
        repo.set_mute_until(1, 1, Some(secs_from_now(-60)))
            .await
            .expect("mute");
        assert_eq!(
            repo.get(1, 1)
                .await
                .expect("get")
                .expect("some")
                .muted_until,
            None
        );

        repo.set_mute_default(1, ChatKind::Private, Some(i32::MAX))
            .await
            .expect("default");
        // A lapsed own mute is still the chat's own setting.
        assert_eq!(
            repo.get(1, 1)
                .await
                .expect("get")
                .expect("some")
                .muted_until,
            None
        );
        // Back to following the default.
        repo.set_mute_until(1, 1, None).await.expect("mute");
        assert_eq!(
            repo.get(1, 1)
                .await
                .expect("get")
                .expect("some")
                .muted_until,
            at(i32::MAX)
        );
    }

    #[tokio::test]
    async fn defaults_roundtrip_and_followers() {
        let db = db_with_account().await;
        let repo = db.chats();
        assert_eq!(
            repo.mute_defaults(1).await.expect("defaults"),
            MuteDefaults::default()
        );

        let defaults = MuteDefaults {
            private: Some(0),
            group: Some(i32::MAX),
            channel: None,
        };
        repo.set_mute_defaults(1, &defaults).await.expect("store");
        assert_eq!(repo.mute_defaults(1).await.expect("defaults"), defaults);
        repo.set_mute_default(1, ChatKind::Channel, Some(7))
            .await
            .expect("store");
        assert_eq!(
            repo.mute_defaults(1).await.expect("defaults").channel,
            Some(7)
        );

        for (id, kind) in [
            (1, ChatKind::Private),
            (2, ChatKind::Private),
            (3, ChatKind::Group),
        ] {
            repo.upsert(&Chat {
                kind,
                ..chat(id, false)
            })
            .await
            .expect("upsert");
        }
        repo.set_mute_until(1, 2, Some(0)).await.expect("mute");
        let followers: Vec<ChatId> = repo
            .list_following_mute_default(1, ChatKind::Private)
            .await
            .expect("list")
            .iter()
            .map(|c| c.id)
            .collect();
        assert_eq!(followers, vec![1]);
        let groups = repo
            .list_following_mute_default(1, ChatKind::Group)
            .await
            .expect("list");
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].muted_until, at(i32::MAX));
    }
}
