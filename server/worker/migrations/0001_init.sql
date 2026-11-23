-- Brief: all state in one D1 database. Times are Unix seconds. Secrets and tokens are stored hashed (SHA-256, hex)
-- or encrypted (AES-256-GCM); no raw token, no raw code, no e-mail address, no IP address is ever stored.

-- Bearer sessions: only the SHA-256 of the token is kept.
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('demo', 'paired')),
  account_id INTEGER,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX sessions_expires ON sessions (expires_at);

-- Items a session has sent or skipped. The primary key makes « handled » a single atomic insert.
CREATE TABLE handled (
  token_hash TEXT NOT NULL,
  item_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('send', 'skip')),
  choice INTEGER,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (token_hash, item_id)
);
CREATE INDEX handled_expires ON handled (expires_at);

-- 6-digit pairing codes (SHA-256 of the code), single use, 10 minutes.
CREATE TABLE pair_codes (
  code_hash TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

-- Failed claims from all addresses together (sliding 10-minute window).
CREATE TABLE pair_failures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL
);
CREATE INDEX pair_failures_at ON pair_failures (at);

-- OAuth `state` values (SHA-256), single use, 10 minutes.
CREATE TABLE oauth_states (
  state_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

-- Accounts that finished the Google sign-in. Only the SHA-256 of the lower-cased e-mail; the refresh token is
-- AES-256-GCM encrypted (base64 IV of 12 bytes + base64 ciphertext with its tag), key = secret TOKEN_KEY.
CREATE TABLE accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email_hash TEXT NOT NULL UNIQUE,
  refresh_iv TEXT NOT NULL,
  refresh_ct TEXT NOT NULL,
  scope TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Fixed-window counters for rate limits and daily caps, updated with one atomic upsert … RETURNING.
CREATE TABLE counters (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  window_end INTEGER NOT NULL
);
CREATE INDEX counters_window_end ON counters (window_end);
