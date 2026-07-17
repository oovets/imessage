-- Cache key for each chat's profile photo (NULL = no photo / not yet known).
ALTER TABLE chats ADD COLUMN avatar_key TEXT;
