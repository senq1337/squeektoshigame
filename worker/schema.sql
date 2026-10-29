-- Squeek Wheel D1 schema
-- Apply: npx wrangler d1 execute squeek-wheel --remote --file=schema.sql

-- One row per Telegram user.
CREATE TABLE IF NOT EXISTS players (
  id            INTEGER PRIMARY KEY,          -- Telegram user id
  username      TEXT,
  first_name    TEXT,
  created_at    INTEGER NOT NULL,             -- unix ms
  total_revs    INTEGER NOT NULL DEFAULT 0,   -- accepted wheel revolutions, all time
  total_points  INTEGER NOT NULL DEFAULT 0,   -- revs x boost, all time
  last_batch_at INTEGER NOT NULL DEFAULT 0,   -- unix ms of last accepted batch (anti-cheat clock)
  last_seq      INTEGER NOT NULL DEFAULT 0    -- last client batch sequence number (replay guard)
);

-- Per-player per-UTC-day stats (daily leaderboard).
CREATE TABLE IF NOT EXISTS daily (
  day       TEXT    NOT NULL,                 -- YYYY-MM-DD (UTC)
  player_id INTEGER NOT NULL,
  revs      INTEGER NOT NULL DEFAULT 0,
  points    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, player_id)
);
CREATE INDEX IF NOT EXISTS daily_points ON daily (day, points DESC);
CREATE INDEX IF NOT EXISTS players_points ON players (total_points DESC);

-- Global per-day "humans vs hamster" scoreboard.
CREATE TABLE IF NOT EXISTS global_daily (
  day               TEXT PRIMARY KEY,
  human_revs        INTEGER NOT NULL DEFAULT 0,
  human_points      INTEGER NOT NULL DEFAULT 0,
  hamster_work      INTEGER NOT NULL DEFAULT 0,  -- hamster work units counted this day (from the live counter)
  recap_sent        INTEGER NOT NULL DEFAULT 0,
  updated_at        INTEGER NOT NULL DEFAULT 0
);

-- Small key/value store: wake/sleep state machine, etc.
CREATE TABLE IF NOT EXISTS kv (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
