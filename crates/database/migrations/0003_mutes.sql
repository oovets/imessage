-- Telegram notification mutes.
--
-- The raw settings are stored exactly as Telegram reports them and resolved
-- to a chat's effective mute on read (shared::model::resolve_mute), so a
-- change to an account default reaches every chat that follows it without
-- rewriting those rows.

-- The chat's own `mute_until` (unix seconds). NULL = no setting of its own,
-- follow the account default for its kind; 0 or a past instant = unmuted.
ALTER TABLE chats ADD COLUMN mute_until INTEGER;

-- Account-wide defaults per chat kind (Telegram's notifyUsers / notifyChats /
-- notifyBroadcasts). Keyed by the same strings as chats.kind so a chat's
-- default is a single join away.
CREATE TABLE mute_defaults (
    account_id  INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL,                   -- 'private' | 'group' | 'channel'
    mute_until  INTEGER,                         -- unix seconds; NULL/0/past = unmuted
    updated_at  TEXT NOT NULL,
    PRIMARY KEY (account_id, kind)
);
