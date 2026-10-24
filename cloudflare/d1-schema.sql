-- Public schema only. Run against the D1 DB binding before enabling account/API routes.
-- Tokens and OAuth states are SHA-256 hashes, never raw browser/provider tokens.
CREATE TABLE IF NOT EXISTS edge_sessions (
  token_hash TEXT PRIMARY KEY,
  user_json TEXT NOT NULL CHECK(json_valid(user_json)),
  expires INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS edge_sessions_expiry ON edge_sessions(expires);

CREATE TABLE IF NOT EXISTS edge_oauth_states (
  state_hash TEXT PRIMARY KEY,
  expires INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS edge_oauth_states_expiry ON edge_oauth_states(expires);

CREATE TABLE IF NOT EXISTS edge_saved (
  owner TEXT NOT NULL,
  paper_id TEXT NOT NULL,
  metadata TEXT NOT NULL CHECK(json_valid(metadata)),
  saved_at TEXT NOT NULL,
  PRIMARY KEY(owner, paper_id)
);
CREATE INDEX IF NOT EXISTS edge_saved_owner_date ON edge_saved(owner, saved_at DESC, paper_id);
-- The statement (and cap check) is atomic across isolates. Existing papers may
-- still be updated at capacity without creating an additional saved record.
CREATE TRIGGER IF NOT EXISTS edge_saved_limit
BEFORE INSERT ON edge_saved
BEGIN
  SELECT RAISE(IGNORE) WHERE
    NOT EXISTS(SELECT 1 FROM edge_saved WHERE owner=NEW.owner AND paper_id=NEW.paper_id)
    AND (SELECT COUNT(*) FROM edge_saved WHERE owner=NEW.owner)>=100;
END;

CREATE TABLE IF NOT EXISTS edge_quota_totals (
  day TEXT PRIMARY KEY,
  count INTEGER NOT NULL CHECK(count >= 0)
);
CREATE TABLE IF NOT EXISTS edge_quota_users (
  day TEXT NOT NULL,
  owner TEXT NOT NULL,
  count INTEGER NOT NULL CHECK(count >= 0),
  PRIMARY KEY(day, owner)
);
CREATE TABLE IF NOT EXISTS edge_quota_reservations (
  id TEXT PRIMARY KEY,
  day TEXT NOT NULL,
  owner TEXT NOT NULL,
  user_limit INTEGER NOT NULL CHECK(user_limit BETWEEN 1 AND 1000),
  global_limit INTEGER NOT NULL CHECK(global_limit BETWEEN 1 AND 1000)
);
CREATE INDEX IF NOT EXISTS edge_quota_reservations_day ON edge_quota_reservations(day);

-- One INSERT plus these triggers is one atomic SQLite statement. A rejected
-- reservation changes neither account nor global counter, even across isolates.
CREATE TRIGGER IF NOT EXISTS edge_quota_check
BEFORE INSERT ON edge_quota_reservations
BEGIN
  SELECT RAISE(IGNORE) WHERE
    COALESCE((SELECT count FROM edge_quota_totals WHERE day = NEW.day), 0) >= NEW.global_limit
    OR COALESCE((SELECT count FROM edge_quota_users WHERE day = NEW.day AND owner = NEW.owner), 0) >= NEW.user_limit;
END;
CREATE TRIGGER IF NOT EXISTS edge_quota_increment
AFTER INSERT ON edge_quota_reservations
BEGIN
  INSERT INTO edge_quota_totals(day, count) VALUES(NEW.day, 1)
    ON CONFLICT(day) DO UPDATE SET count = count + 1;
  INSERT INTO edge_quota_users(day, owner, count) VALUES(NEW.day, NEW.owner, 1)
    ON CONFLICT(day, owner) DO UPDATE SET count = count + 1;
END;

CREATE TABLE IF NOT EXISTS edge_arxiv_schedule (
  name TEXT PRIMARY KEY,
  next_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS edge_cache (
  key TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  expires INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS edge_cache_expiry ON edge_cache(expires);
CREATE TABLE IF NOT EXISTS edge_maintenance (
  name TEXT PRIMARY KEY,
  next_ms INTEGER NOT NULL
);

-- Optional Formula Lens grants. Pairing requires explicit website approval and
-- PKCE proof; only hashes of short-lived scoped access tokens are persisted.
CREATE TABLE IF NOT EXISTS formula_pairings (
  pair_id TEXT PRIMARY KEY CHECK(length(pair_id)=43),
  extension_id TEXT NOT NULL CHECK(length(extension_id)=32 AND extension_id NOT GLOB '*[^a-p]*'),
  challenge TEXT NOT NULL CHECK(length(challenge)=43),
  owner TEXT,
  approved_at INTEGER,
  parent_session_hash TEXT REFERENCES edge_sessions(token_hash) ON DELETE CASCADE
    CHECK(parent_session_hash IS NULL OR length(parent_session_hash)=64),
  expires INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS formula_pairings_expiry ON formula_pairings(expires);
CREATE INDEX IF NOT EXISTS formula_pairings_extension ON formula_pairings(extension_id,expires);
CREATE TABLE IF NOT EXISTS formula_extension_tokens (
  token_hash TEXT PRIMARY KEY CHECK(length(token_hash)=64),
  owner TEXT NOT NULL,
  extension_id TEXT NOT NULL CHECK(length(extension_id)=32 AND extension_id NOT GLOB '*[^a-p]*'),
  scope TEXT NOT NULL CHECK(scope='formula:analyze'),
  parent_session_hash TEXT NOT NULL REFERENCES edge_sessions(token_hash) ON DELETE CASCADE CHECK(length(parent_session_hash)=64),
  expires INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS formula_extension_tokens_expiry ON formula_extension_tokens(expires);
CREATE INDEX IF NOT EXISTS formula_extension_tokens_owner ON formula_extension_tokens(owner,expires);
