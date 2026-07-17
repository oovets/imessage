-- Initial schema.
--
-- Every account-scoped table is keyed by account_id so a single database
-- serves all logged-in accounts (multi-account is a first-class feature).
-- The database is the offline-first source of truth: the UI only ever reads
-- from here, never directly from the network.

CREATE TABLE accounts (
    id            INTEGER PRIMARY KEY,            -- Telegram user id of the owner
    phone         TEXT,
    first_name    TEXT NOT NULL DEFAULT '',
    last_name     TEXT,
    username      TEXT,
    authorized    INTEGER NOT NULL DEFAULT 0,     -- bool: session currently valid
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);

CREATE TABLE chats (
    account_id            INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    id                    INTEGER NOT NULL,       -- canonical (Bot-API style) chat id
    kind                  TEXT NOT NULL,          -- 'private' | 'group' | 'channel'
    title                 TEXT NOT NULL,
    username              TEXT,
    unread_count          INTEGER NOT NULL DEFAULT 0,
    pinned                INTEGER NOT NULL DEFAULT 0,
    last_message_at       TEXT,
    last_message_preview  TEXT,
    updated_at            TEXT NOT NULL,
    PRIMARY KEY (account_id, id)
);

-- Chat list ordering: pinned first, then most recent activity.
CREATE INDEX idx_chats_order ON chats (account_id, pinned DESC, last_message_at DESC);

CREATE TABLE messages (
    rowid        INTEGER PRIMARY KEY,             -- explicit rowid: FTS external-content anchor
    account_id   INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    chat_id      INTEGER NOT NULL,
    id           INTEGER NOT NULL,                -- Telegram message id; negative = local pending
    sender_id    INTEGER,
    sender_name  TEXT,
    text         TEXT NOT NULL DEFAULT '',
    media        TEXT,                            -- JSON (shared::model::Media)
    reactions    TEXT NOT NULL DEFAULT '[]',      -- JSON (Vec<shared::model::Reaction>)
    reply_to     INTEGER,
    date         TEXT NOT NULL,
    edited       INTEGER NOT NULL DEFAULT 0,
    outgoing     INTEGER NOT NULL DEFAULT 0,
    send_state   TEXT NOT NULL DEFAULT 'sent',    -- 'pending' | 'sent' | 'failed'
    UNIQUE (account_id, chat_id, id)
);

-- History pagination within a chat.
CREATE INDEX idx_messages_chat_date ON messages (account_id, chat_id, date DESC, id DESC);

-- Full-text search over message text (offline search).
-- External-content table: text lives only in `messages`; FTS stores the index.
CREATE VIRTUAL TABLE messages_fts USING fts5(
    text,
    content='messages',
    content_rowid='rowid',
    tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts (rowid, text) VALUES (new.rowid, new.text);
END;

CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts (messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;

CREATE TRIGGER messages_au AFTER UPDATE OF text ON messages BEGIN
    INSERT INTO messages_fts (messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
    INSERT INTO messages_fts (rowid, text) VALUES (new.rowid, new.text);
END;

-- Cached user presence/profile snippets (for sender names & last-seen).
CREATE TABLE users (
    account_id  INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    id          INTEGER NOT NULL,
    first_name  TEXT NOT NULL DEFAULT '',
    last_name   TEXT,
    username    TEXT,
    presence    TEXT,                             -- JSON (shared::model::Presence)
    updated_at  TEXT NOT NULL,
    PRIMARY KEY (account_id, id)
);
