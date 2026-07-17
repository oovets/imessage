//! Message persistence, pagination and offline full-text search.
//!
//! Outgoing messages follow the offline-first write path: they are inserted
//! immediately with a **negative local id** and `send_state = 'pending'`,
//! then re-keyed to the server-assigned id once Telegram acknowledges
//! ([`MessageRepo::confirm_sent`]). The UI therefore shows the message the
//! instant the user hits Enter, network or not.

use chrono::{DateTime, Utc};
use shared::model::{AccountId, ChatId, Media, Message, MessageId, Reaction, SendState};
use sqlx::{Row, SqlitePool};

use crate::DbResult;

/// Repository for the `messages` table and its FTS index.
#[derive(Debug, Clone)]
pub struct MessageRepo {
    pool: SqlitePool,
}

impl MessageRepo {
    pub(crate) fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    pub async fn upsert(&self, message: &Message) -> DbResult<()> {
        sqlx::query(
            r#"
            INSERT INTO messages (account_id, chat_id, id, sender_id, sender_name, text,
                                  media, reactions, reply_to, date, edited, outgoing, send_state)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
            ON CONFLICT(account_id, chat_id, id) DO UPDATE SET
                sender_id = excluded.sender_id,
                sender_name = excluded.sender_name,
                text = excluded.text,
                media = excluded.media,
                reactions = excluded.reactions,
                reply_to = excluded.reply_to,
                date = excluded.date,
                edited = excluded.edited,
                outgoing = excluded.outgoing,
                send_state = excluded.send_state
            "#,
        )
        .bind(message.account_id)
        .bind(message.chat_id)
        .bind(message.id)
        .bind(message.sender_id)
        .bind(&message.sender_name)
        .bind(&message.text)
        .bind(
            message
                .media
                .as_ref()
                .map(serde_json::to_string)
                .transpose()?,
        )
        .bind(serde_json::to_string(&message.reactions)?)
        .bind(message.reply_to)
        .bind(message.date)
        .bind(message.edited)
        .bind(message.outgoing)
        .bind(send_state_to_str(message.send_state))
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Page of history for a chat, newest first. `before` paginates backwards:
    /// pass the oldest currently loaded (date, id) to fetch the previous page.
    pub async fn history(
        &self,
        account_id: AccountId,
        chat_id: ChatId,
        before: Option<(DateTime<Utc>, MessageId)>,
        limit: u32,
    ) -> DbResult<Vec<Message>> {
        let rows = match before {
            Some((date, id)) => {
                sqlx::query(
                    "SELECT * FROM messages
                     WHERE account_id = ?1 AND chat_id = ?2 AND (date, id) < (?3, ?4)
                     ORDER BY date DESC, id DESC LIMIT ?5",
                )
                .bind(account_id)
                .bind(chat_id)
                .bind(date)
                .bind(id)
                .bind(limit)
                .fetch_all(&self.pool)
                .await?
            }
            None => {
                sqlx::query(
                    "SELECT * FROM messages
                     WHERE account_id = ?1 AND chat_id = ?2
                     ORDER BY date DESC, id DESC LIMIT ?3",
                )
                .bind(account_id)
                .bind(chat_id)
                .bind(limit)
                .fetch_all(&self.pool)
                .await?
            }
        };
        rows.iter().map(row_to_message).collect()
    }

    pub async fn get(
        &self,
        account_id: AccountId,
        chat_id: ChatId,
        id: MessageId,
    ) -> DbResult<Option<Message>> {
        let row = sqlx::query(
            "SELECT * FROM messages WHERE account_id = ?1 AND chat_id = ?2 AND id = ?3",
        )
        .bind(account_id)
        .bind(chat_id)
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        row.as_ref().map(row_to_message).transpose()
    }

    pub async fn delete(
        &self,
        account_id: AccountId,
        chat_id: ChatId,
        ids: &[MessageId],
    ) -> DbResult<()> {
        // SQLite has no array binds; ids arrive in small batches (update
        // payloads), so a per-id statement inside one transaction is fine.
        let mut tx = self.pool.begin().await?;
        for id in ids {
            sqlx::query("DELETE FROM messages WHERE account_id = ?1 AND chat_id = ?2 AND id = ?3")
                .bind(account_id)
                .bind(chat_id)
                .bind(id)
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
        Ok(())
    }

    /// Re-key a pending local message (negative id) to its server id and mark
    /// it sent. Returns the updated message.
    pub async fn confirm_sent(
        &self,
        account_id: AccountId,
        chat_id: ChatId,
        local_id: MessageId,
        server_id: MessageId,
        date: DateTime<Utc>,
    ) -> DbResult<Option<Message>> {
        sqlx::query(
            "UPDATE messages SET id = ?4, date = ?5, send_state = 'sent'
             WHERE account_id = ?1 AND chat_id = ?2 AND id = ?3",
        )
        .bind(account_id)
        .bind(chat_id)
        .bind(local_id)
        .bind(server_id)
        .bind(date)
        .execute(&self.pool)
        .await?;
        self.get(account_id, chat_id, server_id).await
    }

    pub async fn mark_failed(
        &self,
        account_id: AccountId,
        chat_id: ChatId,
        local_id: MessageId,
    ) -> DbResult<()> {
        sqlx::query(
            "UPDATE messages SET send_state = 'failed'
             WHERE account_id = ?1 AND chat_id = ?2 AND id = ?3",
        )
        .bind(account_id)
        .bind(chat_id)
        .bind(local_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Delete messages by id across all *non-channel* chats of an account,
    /// returning which (chat, message) rows were removed.
    ///
    /// Telegram's `updateDeleteMessages` does not say which chat the ids
    /// belong to — but for private and basic-group chats the id sequence is
    /// account-wide, so the ids alone are unambiguous. Channel deletions
    /// arrive separately with an explicit channel id and use
    /// [`MessageRepo::delete`] instead.
    pub async fn delete_by_ids_nonchannel(
        &self,
        account_id: AccountId,
        ids: &[MessageId],
    ) -> DbResult<Vec<(ChatId, MessageId)>> {
        // Bot-API channel ids are below -1_000_000_000_000.
        const CHANNEL_ID_CUTOFF: i64 = -1_000_000_000_000;
        let mut deleted = Vec::new();
        let mut tx = self.pool.begin().await?;
        for id in ids {
            let rows = sqlx::query(
                "DELETE FROM messages
                 WHERE account_id = ?1 AND id = ?2 AND chat_id > ?3
                 RETURNING chat_id, id",
            )
            .bind(account_id)
            .bind(id)
            .bind(CHANNEL_ID_CUTOFF)
            .fetch_all(&mut *tx)
            .await?;
            for row in rows {
                deleted.push((row.try_get("chat_id")?, row.try_get("id")?));
            }
        }
        tx.commit().await?;
        Ok(deleted)
    }

    /// Offline full-text search. `chat_id = None` searches across all chats
    /// of the account. Results newest-first.
    pub async fn search(
        &self,
        account_id: AccountId,
        chat_id: Option<ChatId>,
        query: &str,
        limit: u32,
    ) -> DbResult<Vec<Message>> {
        // Escape the FTS5 query: treat user input as literal terms, not syntax.
        let fts_query = query
            .split_whitespace()
            .map(|term| format!("\"{}\"", term.replace('"', "\"\"")))
            .collect::<Vec<_>>()
            .join(" ");
        if fts_query.is_empty() {
            return Ok(Vec::new());
        }
        let rows = match chat_id {
            Some(chat_id) => {
                sqlx::query(
                    "SELECT m.* FROM messages m
                     JOIN messages_fts f ON f.rowid = m.rowid
                     WHERE messages_fts MATCH ?1 AND m.account_id = ?2 AND m.chat_id = ?3
                     ORDER BY m.date DESC LIMIT ?4",
                )
                .bind(&fts_query)
                .bind(account_id)
                .bind(chat_id)
                .bind(limit)
                .fetch_all(&self.pool)
                .await?
            }
            None => {
                sqlx::query(
                    "SELECT m.* FROM messages m
                     JOIN messages_fts f ON f.rowid = m.rowid
                     WHERE messages_fts MATCH ?1 AND m.account_id = ?2
                     ORDER BY m.date DESC LIMIT ?3",
                )
                .bind(&fts_query)
                .bind(account_id)
                .bind(limit)
                .fetch_all(&self.pool)
                .await?
            }
        };
        rows.iter().map(row_to_message).collect()
    }
}

fn send_state_to_str(state: SendState) -> &'static str {
    match state {
        SendState::Pending => "pending",
        SendState::Sent => "sent",
        SendState::Failed => "failed",
    }
}

fn send_state_from_str(s: &str) -> SendState {
    match s {
        "pending" => SendState::Pending,
        "failed" => SendState::Failed,
        _ => SendState::Sent,
    }
}

fn row_to_message(row: &sqlx::sqlite::SqliteRow) -> DbResult<Message> {
    let media: Option<String> = row.try_get("media")?;
    let reactions: String = row.try_get("reactions")?;
    let send_state: String = row.try_get("send_state")?;
    Ok(Message {
        account_id: row.try_get("account_id")?,
        chat_id: row.try_get("chat_id")?,
        id: row.try_get("id")?,
        sender_id: row.try_get("sender_id")?,
        sender_name: row.try_get("sender_name")?,
        text: row.try_get("text")?,
        media: media
            .as_deref()
            .map(serde_json::from_str::<Media>)
            .transpose()?,
        reactions: serde_json::from_str::<Vec<Reaction>>(&reactions)?,
        reply_to: row.try_get("reply_to")?,
        date: row.try_get("date")?,
        edited: row.try_get("edited")?,
        outgoing: row.try_get("outgoing")?,
        send_state: send_state_from_str(&send_state),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Database;
    use shared::model::Account;

    async fn db() -> Database {
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

    fn msg(id: MessageId, text: &str, secs: i64) -> Message {
        Message {
            account_id: 1,
            chat_id: 100,
            id,
            sender_id: Some(7),
            sender_name: Some("Alice".into()),
            text: text.into(),
            media: None,
            reactions: vec![],
            reply_to: None,
            date: Utc::now() + chrono::Duration::seconds(secs),
            edited: false,
            outgoing: false,
            send_state: SendState::Sent,
        }
    }

    #[tokio::test]
    async fn history_pagination_newest_first() {
        let db = db().await;
        let repo = db.messages();
        for i in 1..=5 {
            repo.upsert(&msg(i, &format!("m{i}"), i as i64)).await.expect("insert");
        }
        let first = repo.history(1, 100, None, 2).await.expect("page");
        assert_eq!(first.iter().map(|m| m.id).collect::<Vec<_>>(), vec![5, 4]);
        let last = first.last().expect("nonempty");
        let second = repo
            .history(1, 100, Some((last.date, last.id)), 10)
            .await
            .expect("page");
        assert_eq!(second.iter().map(|m| m.id).collect::<Vec<_>>(), vec![3, 2, 1]);
    }

    #[tokio::test]
    async fn fts_search_finds_and_escapes() {
        let db = db().await;
        let repo = db.messages();
        repo.upsert(&msg(1, "the quick brown fox", 0)).await.expect("insert");
        repo.upsert(&msg(2, "lazy dog sleeps", 1)).await.expect("insert");

        let hits = repo.search(1, None, "quick fox", 10).await.expect("search");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, 1);

        // FTS syntax characters in user input must not break the query.
        let hits = repo.search(1, None, "\"dog OR", 10).await.expect("search");
        assert!(hits.len() <= 1);
    }

    #[tokio::test]
    async fn pending_send_confirm_flow() {
        let db = db().await;
        let repo = db.messages();
        let mut m = msg(-42, "outgoing", 0);
        m.outgoing = true;
        m.send_state = SendState::Pending;
        repo.upsert(&m).await.expect("insert");

        let confirmed = repo
            .confirm_sent(1, 100, -42, 555, Utc::now())
            .await
            .expect("confirm")
            .expect("row");
        assert_eq!(confirmed.id, 555);
        assert_eq!(confirmed.send_state, SendState::Sent);
        assert!(repo.get(1, 100, -42).await.expect("get").is_none());
    }

    #[tokio::test]
    async fn edit_updates_fts_index() {
        let db = db().await;
        let repo = db.messages();
        repo.upsert(&msg(1, "original words", 0)).await.expect("insert");
        let mut edited = msg(1, "replacement content", 0);
        edited.edited = true;
        repo.upsert(&edited).await.expect("update");

        assert!(repo.search(1, None, "original", 10).await.expect("s").is_empty());
        assert_eq!(repo.search(1, None, "replacement", 10).await.expect("s").len(), 1);
    }
}
