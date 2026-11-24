-- Day 5 (BRIEF-D5 § 3.5): « Speak a change ». 0001, 0002 and 0003 are deployed: never edited.
-- Stored: the CHECKED draft only (it already passed checkSpoken), one per item (per session in demo); a new one
-- replaces the old one. Never the clip, never what was heard.
-- Paired: on the message row, written by ONE conditional UPDATE that changes the row only while it is not handled.
ALTER TABLE messages ADD COLUMN spoken_draft TEXT;
ALTER TABLE messages ADD COLUMN spoken_at INTEGER;
-- Demo: per session and frozen item. Its rows go when the session's other rows go: the purge (expires_at = the
-- session's) and the logout.
CREATE TABLE spoken (
  token_hash TEXT NOT NULL,
  item_id TEXT NOT NULL,
  draft TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (token_hash, item_id)
);
CREATE INDEX spoken_expires ON spoken (expires_at);
