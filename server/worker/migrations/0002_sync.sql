-- Day 3 (BRIEF-D3 § 3.5): the sync of ONE Gmail label and the primary calendar. 0001_init.sql is deployed: never edited.
-- Stored: Gmail message and thread ids, persona keys, times, the validated triage result, event ids, titles, start
-- times, the validated brief lines. NEVER stored: a body, a subject, a real address, a token in clear.

-- The account's grant state, its sealed access token (AES-256-GCM, AAD "access:<email_hash>") and the label id.
-- self_hash = SHA-256 (hex) of the lower-cased address, what the Gmail parser compares senders with. Accounts signed
-- in before day 3 have none: they need a new sign-in, which sets it and clears needs_signin.
ALTER TABLE accounts ADD COLUMN self_hash TEXT;
ALTER TABLE accounts ADD COLUMN needs_signin INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN access_iv TEXT;
ALTER TABLE accounts ADD COLUMN access_ct TEXT;
ALTER TABLE accounts ADD COLUMN access_expires_at INTEGER;
ALTER TABLE accounts ADD COLUMN label_id TEXT;
UPDATE accounts SET needs_signin = 1 WHERE self_hash IS NULL;

-- One row per Gmail message id seen in the label, per account.
-- state: ignored (not a persona alias: never fetched again) · claimed (a run is triaging it until lease_until) ·
-- retry (a triage failed; tried again later) · failed (3 tries used) · done (triaged; result in triage_results).
CREATE TABLE messages (
  account_id INTEGER NOT NULL,
  msg_id TEXT NOT NULL,
  thread_id TEXT,
  persona TEXT,
  received_at INTEGER,
  state TEXT NOT NULL CHECK (state IN ('ignored', 'claimed', 'retry', 'failed', 'done')),
  tries INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER,
  handled_at INTEGER,
  handled_action TEXT CHECK (handled_action IN ('send', 'skip')),
  handled_choice INTEGER,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, msg_id)
);
CREATE INDEX messages_list ON messages (account_id, state, received_at);

-- triageOnce's ResultStore: id = "<account id>:<message id>", result = the validated TriageResult as JSON.
CREATE TABLE triage_results (
  id TEXT PRIMARY KEY,
  result TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Today's events of the account (the next 24 hours, 5 at most), only those the account itself created.
-- brief = the validated brief as JSON, or NULL.
CREATE TABLE events (
  account_id INTEGER NOT NULL,
  event_id TEXT NOT NULL,
  start_at INTEGER NOT NULL,
  title TEXT NOT NULL,
  persona TEXT,
  brief TEXT,
  brief_tries INTEGER NOT NULL DEFAULT 0,
  brief_lease_until INTEGER,
  synced_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, event_id)
);
CREATE INDEX events_start ON events (account_id, start_at);
