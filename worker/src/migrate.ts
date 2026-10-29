// Schema migrations, applied automatically by the Worker (no manual `d1 execute` after the first deploy).
// Each step must be safe to re-run: CREATE ... IF NOT EXISTS, or ALTER ... ADD COLUMN
// (a "duplicate column" error from a re-run is ignored).

export const MIGRATIONS: string[][] = [
  // 1: base schema (same as schema.sql v1)
  [
    "CREATE TABLE IF NOT EXISTS players (id INTEGER PRIMARY KEY, username TEXT, first_name TEXT, created_at INTEGER NOT NULL, total_revs INTEGER NOT NULL DEFAULT 0, total_points INTEGER NOT NULL DEFAULT 0, last_batch_at INTEGER NOT NULL DEFAULT 0, last_seq INTEGER NOT NULL DEFAULT 0)",
    "CREATE TABLE IF NOT EXISTS daily (day TEXT NOT NULL, player_id INTEGER NOT NULL, revs INTEGER NOT NULL DEFAULT 0, points INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, player_id))",
    "CREATE INDEX IF NOT EXISTS daily_points ON daily (day, points DESC)",
    "CREATE INDEX IF NOT EXISTS players_points ON players (total_points DESC)",
    "CREATE TABLE IF NOT EXISTS global_daily (day TEXT PRIMARY KEY, human_revs INTEGER NOT NULL DEFAULT 0, human_points INTEGER NOT NULL DEFAULT 0, hamster_work INTEGER NOT NULL DEFAULT 0, recap_sent INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0)",
    "CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)",
  ],
  // 2: referrals — who invited whom, and bonus points earned from friends
  [
    "ALTER TABLE players ADD COLUMN ref_by INTEGER",
    "ALTER TABLE players ADD COLUMN ref_points INTEGER NOT NULL DEFAULT 0",
    "CREATE INDEX IF NOT EXISTS players_ref ON players (ref_by)",
  ],
  // 3: wake-up pings (opt-in) and personal cards
  [
    "ALTER TABLE players ADD COLUMN notify INTEGER NOT NULL DEFAULT 0", // 1 = ping me when he runs
    "ALTER TABLE players ADD COLUMN last_ping_at INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE players ADD COLUMN chat_ok INTEGER NOT NULL DEFAULT 1", // 0 = bot can't message them
    "ALTER TABLE players ADD COLUMN last_card_at INTEGER NOT NULL DEFAULT 0",
    "CREATE INDEX IF NOT EXISTS players_notify ON players (notify, id)",
  ],
];

export const SCHEMA_VERSION = MIGRATIONS.length;

let ready = false; // per isolate: once checked, don't touch the DB again

/** Bring the database to SCHEMA_VERSION. Cheap after the first call in an isolate. */
export async function ensureSchema(db: D1Database): Promise<void> {
  if (ready) return;
  let current = 0;
  try {
    const row = await db.prepare("SELECT value FROM kv WHERE key = 'schema_v'").first<{ value: string }>();
    // A database created by schema.sql (v1) has a kv table but no schema_v yet.
    current = row ? Number(JSON.parse(row.value)) : 1;
  } catch {
    current = 0; // no kv table yet: brand-new database
  }
  for (let v = current; v < SCHEMA_VERSION; v++) {
    for (const sql of MIGRATIONS[v]) {
      try {
        await db.prepare(sql).run();
      } catch (e) {
        if (!/duplicate column/i.test(String(e))) throw e;
      }
    }
    await db
      .prepare(
        "INSERT INTO kv (key, value, updated_at) VALUES ('schema_v', ?, ?) " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      )
      .bind(JSON.stringify(v + 1), Date.now())
      .run();
  }
  ready = true;
}

/** For tests. */
export const _resetSchemaFlag = () => {
  ready = false;
};
