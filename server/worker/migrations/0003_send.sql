-- Day 4 (BRIEF-D4 § 3.9): the real send. 0001_init.sql and 0002_sync.sql are deployed: never edited.
-- send_state: NULL (never claimed for a real send, or a claim released after a definite failure) · sending (claimed,
-- the Google calls are running; a row left here by a crash is treated as unknown: handled, never offered again) ·
-- sent (Google answered 200 with an id: sent_id) · unknown (the send may have left: never retried, never offered).
-- Stored: the state, Gmail's id of the sent message, the times and the choice index (handled_*). Never the text,
-- never an address.
ALTER TABLE messages ADD COLUMN send_state TEXT CHECK (send_state IN ('sending', 'sent', 'unknown'));
ALTER TABLE messages ADD COLUMN sent_id TEXT;
