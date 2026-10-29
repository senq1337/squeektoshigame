// Squeektoshi game — Cloudflare Worker
// The mini-app (web/index.html) is served by this same Worker as a static asset, so the
// app and the API share one origin: https://<name>.<subdomain>.workers.dev
// Routes:
//   GET  /                          the mini-app (static asset)
//   GET  /api/state                 live hamster + today's humans-vs-hamster score
//                                   (also sets the bot up on first call: webhook, menu button)
//   POST /api/spin                  { revs, seq } + header X-Init-Data  -> accepted revs, my stats
//   GET  /api/me                    my day, totals, friends invited, my invite link (X-Init-Data)
//   POST /api/notify                { on } -> opt in/out of "he's running" pings
//   GET  /api/avatar                my Telegram profile photo (proxied: file URLs contain the token)
//   POST /api/card                  PNG bytes of my card -> the bot sends it to my private chat
//   POST /api/wallet                { address } (EVM, or null to remove) -> my saved wallet
//   GET  /api/leaderboard?scope=today|all
//   POST /tg/webhook                Telegram bot updates (/start [r<id>], /top, /hamster, /invite, /wallet,
//                                   buttons; admins: /export [all|week|today] [N] -> CSV of the top)
// Referrals: t.me/<bot>?start=r<id> (or a Mini App link with startapp=r<id>) marks the new player
// as invited by <id>; the inviter then earns REF_BONUS_PCT% of every point the friend earns.
// The schema migrates itself (src/migrate.ts).
// Cron:
//   every minute  poll hamster, count hamster work for the day, wake/sleep alerts;
//                 06:00–06:30 UTC also (re)tries yesterday's recap until it's delivered

import {
  acceptBatch,
  boostMilli,
  hamsterDelta,
  humanWork,
  nextPingRun,
  parseRef,
  PING_BATCH,
  PING_COOLDOWN_MS,
  pointsFor,
  type PingRun,
  refBonus,
  REF_BONUS_PCT,
  stepWake,
  utcDay,
  type WakeMachine,
} from "./game";
import { getHamster, type HamsterState } from "./hamster";
import { ensureSchema } from "./migrate";
import {
  esc,
  sendMessage,
  sendPhoto,
  sendDocumentText,
  sendPhotoBytes,
  tgCall,
  userPhoto,
  verifyInitData,
  type InlineButton,
  type TgUser,
} from "./telegram";
import { checkAddress, parseN, parseScope, shortAddr, toChecksum, toCsv, type ExportRow, type ExportScope } from "./wallet";

export interface Env {
  DB: D1Database;
  STATUS_URL: string;
  WEBAPP_URL: string; // optional override; empty = this Worker's own origin
  ALLOWED_ORIGIN: string;
  ALERT_CHAT_ID: string;
  DEV_ALLOW_UNSIGNED: string;
  APP_LINK?: string; // optional t.me/<bot>/<app> link for buttons in channels
  ADMIN_IDS?: string; // secret or var: comma-separated Telegram ids allowed to /export
  BOT_TOKEN: string; // secret
  WEBHOOK_SECRET: string; // secret
}

// ---------------------------------------------------------------- helpers

const cors = (env: Env) => ({
  "access-control-allow-origin": env.ALLOWED_ORIGIN || "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type,x-init-data",
  "access-control-max-age": "86400",
});

const json = (env: Env, data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...cors(env) },
  });

async function kvGet<T>(db: D1Database, key: string): Promise<T | null> {
  const row = await db.prepare("SELECT value FROM kv WHERE key = ?").bind(key).first<{ value: string }>();
  return row ? (JSON.parse(row.value) as T) : null;
}

function kvPut(db: D1Database, key: string, value: unknown, now: number) {
  return db
    .prepare(
      "INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    )
    .bind(key, JSON.stringify(value), now);
}

function hamsterNow(env: Env, now: number): Promise<HamsterState> {
  return getHamster(env.STATUS_URL, now, () => kvGet<HamsterState>(env.DB, "hamster_last"));
}

/** Resolve the Telegram user from X-Init-Data (or a dev user when explicitly allowed). */
async function authUser(req: Request, env: Env): Promise<TgUser | null> {
  const initData = req.headers.get("x-init-data") ?? "";
  if (initData) return verifyInitData(initData, env.BOT_TOKEN, Math.floor(Date.now() / 1000));
  if (env.DEV_ALLOW_UNSIGNED === "1") {
    const id = Number(new URL(req.url).searchParams.get("dev_user") ?? "1");
    return { id, username: `dev${id}`, first_name: "Dev" };
  }
  return null;
}

const displayName = (r: { username: string | null; first_name: string | null; id: number }) =>
  r.username ? `@${r.username}` : r.first_name || `player ${String(r.id).slice(-4)}`;

/** For channel posts: a t.me link if configured, otherwise a plain link to the app. */
const spinButton = (env: Env, appUrl: string, text = "🐹 Spin the wheel"): InlineButton =>
  env.APP_LINK ? { text, url: env.APP_LINK } : { text, url: appUrl };

// ---------------------------------------------------------------- one-time bot setup

/** Bump to re-run setup after changing commands/texts. */
const SETUP_VERSION = 4;
const BOT_NAME = "Squeektoshi Game";

interface SetupState {
  origin: string;
  v: number;
  username?: string; // the bot's @username, for invite links
}

async function botUsername(env: Env): Promise<string | null> {
  return (await kvGet<SetupState>(env.DB, "bot_setup"))?.username ?? null;
}

/** Personal invite link: opens the Mini App directly if APP_LINK is set, else the bot chat. */
function inviteLink(env: Env, username: string | null, userId: number): string | null {
  if (env.APP_LINK) return `${env.APP_LINK}${env.APP_LINK.includes("?") ? "&" : "?"}startapp=r${userId}`;
  return username ? `https://t.me/${username}?start=r${userId}` : null;
}

const INVITE_TEXT = `Spin the wheel with Squeektoshi, the hamster mining Squeekchain 🐹 When he runs, his rpm boosts your spins.`;
const shareUrl = (link: string) =>
  `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(INVITE_TEXT)}`;
let lastSetupTry = 0;
/** For tests. */
export const _resetSetupThrottle = () => {
  lastSetupTry = 0;
};

/** The app's public URL: explicit WEBAPP_URL, else the origin recorded at setup. */
async function appUrl(env: Env): Promise<string> {
  if (env.WEBAPP_URL) return env.WEBAPP_URL;
  const s = await kvGet<{ origin: string }>(env.DB, "bot_setup");
  return s?.origin ?? "";
}

/**
 * Points the bot at this Worker the first time the app is opened from its real URL:
 * webhook (with the secret Telegram echoes back), menu button that opens the app,
 * command list, and a "community, not affiliated" description. Runs once per origin.
 */
export async function ensureBotSetup(env: Env, origin: string): Promise<void> {
  if (!env.BOT_TOKEN || !env.WEBHOOK_SECRET || !origin.startsWith("https://")) return;
  const now = Date.now();
  if (now - lastSetupTry < 60_000) return; // at most once a minute per isolate
  const done = await kvGet<SetupState>(env.DB, "bot_setup");
  if (done && done.origin === origin && done.v === SETUP_VERSION) return;
  lastSetupTry = now;

  const url = env.WEBAPP_URL || origin;
  const t = env.BOT_TOKEN;
  const results = (await Promise.all([
    tgCall(t, "setWebhook", {
      url: `${origin}/tg/webhook`,
      secret_token: env.WEBHOOK_SECRET,
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: true,
    }),
    tgCall(t, "setChatMenuButton", { menu_button: { type: "web_app", text: "Spin", web_app: { url } } }),
    tgCall(t, "getMe", {}),
    tgCall(t, "setMyName", { name: BOT_NAME }),
    tgCall(t, "setMyCommands", {
      commands: [
        { command: "start", description: "Open the wheel" },
        { command: "hamster", description: "Is Squeektoshi running right now?" },
        { command: "top", description: "Today's top spinners" },
        { command: "invite", description: "Your invite link (+10% of friends' points)" },
        { command: "alerts", description: "Ping me when Squeektoshi runs (on/off)" },
        { command: "wallet", description: "Add or change your EVM wallet" },
      ],
    }),
    tgCall(t, "setMyShortDescription", {
      short_description: "Spin the wheel with Squeektoshi. Community game, not affiliated with Squeekchain.",
    }),
    tgCall(t, "setMyDescription", {
      description:
        "Spin your wheel together with Squeektoshi, the hamster mining Squeekchain. " +
        "When he runs, his live rpm boosts your spins; when he sleeps, the humans take the night shift.\n\n" +
        "Community-built on Squeekchain's public data. Not affiliated with Squeekchain.",
    }),
  ])) as ({ ok?: boolean; result?: any } | null)[];

  // Webhook, menu button and getMe (for invite links) are the ones that matter; the rest is cosmetic.
  const username: string | undefined = results[2]?.result?.username;
  if (results[0]?.ok && results[1]?.ok && username) {
    const state: SetupState = { origin, v: SETUP_VERSION, username };
    await kvPut(env.DB, "bot_setup", state, now).run();
  }
}

interface GlobalRow {
  human_revs: number;
  human_points: number;
  hamster_work: number;
}

async function globalToday(env: Env, day: string): Promise<GlobalRow> {
  return (
    (await env.DB.prepare(
      "SELECT human_revs, human_points, hamster_work FROM global_daily WHERE day = ?",
    )
      .bind(day)
      .first<GlobalRow>()) ?? { human_revs: 0, human_points: 0, hamster_work: 0 }
  );
}

function statePayload(h: HamsterState, g: GlobalRow, day: string) {
  return {
    day,
    hamster: {
      signal: h.signal,
      running: h.running,
      fault: h.fault,
      rpm: Math.round(h.rpm * 10) / 10,
      blockHeight: h.blockHeight,
      observedAt: h.observedAt,
    },
    boost: boostMilli(h.running, h.rpm) / 1000,
    today: {
      humanRevs: g.human_revs,
      humanWork: humanWork(g.human_revs),
      hamsterWork: g.hamster_work,
    },
  };
}

// ---------------------------------------------------------------- referrals

/**
 * Mark `user` as invited by `refId`. Only for players who haven't spun yet and have no inviter,
 * only if the inviter is a real player, never yourself, and no direct A<->B loop.
 * Returns true if the referral was recorded.
 */
async function attachReferral(
  env: Env,
  user: { id: number; username?: string; first_name?: string },
  refId: number | null,
  now: number,
): Promise<boolean> {
  if (!refId || refId === user.id) return false;
  const inviter = await env.DB.prepare("SELECT id, ref_by FROM players WHERE id = ?")
    .bind(refId)
    .first<{ id: number; ref_by: number | null }>();
  if (!inviter || inviter.ref_by === user.id) return false;
  await env.DB.prepare(
    "INSERT OR IGNORE INTO players (id, username, first_name, created_at, ref_by) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(user.id, user.username ?? null, user.first_name ?? null, now, refId)
    .run();
  const upd = await env.DB.prepare(
    "UPDATE players SET ref_by = ? WHERE id = ? AND (ref_by IS NULL OR ref_by = ?) AND total_revs = 0",
  )
    .bind(refId, user.id, refId)
    .run();
  return upd.meta.changes > 0;
}

async function rankFor(env: Env, scope: "today" | "all", day: string, points: number): Promise<number> {
  const ahead =
    scope === "all"
      ? await env.DB.prepare("SELECT COUNT(*) AS n FROM players WHERE total_points > ?").bind(points).first<{ n: number }>()
      : await env.DB.prepare("SELECT COUNT(*) AS n FROM daily WHERE day = ? AND points > ?").bind(day, points).first<{ n: number }>();
  return (ahead?.n ?? 0) + 1;
}

// ---------------------------------------------------------------- pings + cards

const alertsText = (on: boolean) =>
  on
    ? "🔔 Done. I'll ping you when Squeektoshi starts running (at most once every 3 hours). /alerts off to stop."
    : "🔕 Pings are off. /alerts on to turn them back on.";

async function setNotify(env: Env, u: { id: number; username?: string; first_name?: string }, on: boolean, now: number) {
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO players (id, username, first_name, created_at) VALUES (?, ?, ?, ?)").bind(
      u.id,
      u.username ?? null,
      u.first_name ?? null,
      now,
    ),
    env.DB.prepare("UPDATE players SET notify = ? WHERE id = ?").bind(on ? 1 : 0, u.id),
  ]);
}

async function handleNotify(req: Request, env: Env): Promise<Response> {
  const user = await authUser(req, env);
  if (!user) return json(env, { error: "unauthorized" }, 401);
  const body = (await req.json().catch(() => ({}))) as { on?: unknown };
  const on = body.on === true;
  await setNotify(env, user, on, Date.now());
  // Confirm in the chat; if the bot can't message them yet, tell the app so it can say "press Start".
  const r = (await sendMessage(env.BOT_TOKEN, user.id, alertsText(on))) as { ok?: boolean } | null;
  if (!r?.ok) await env.DB.prepare("UPDATE players SET chat_ok = 0 WHERE id = ?").bind(user.id).run();
  else await env.DB.prepare("UPDATE players SET chat_ok = 1 WHERE id = ?").bind(user.id).run();
  return json(env, { notify: on, chatOk: !!r?.ok });
}

async function handleAvatar(req: Request, env: Env): Promise<Response> {
  const user = await authUser(req, env);
  if (!user) return json(env, { error: "unauthorized" }, 401);
  const bytes = env.BOT_TOKEN ? await userPhoto(env.BOT_TOKEN, user.id) : null;
  if (!bytes) return json(env, { error: "no_photo" }, 404);
  return new Response(bytes, { headers: { "content-type": "image/jpeg", "cache-control": "private, max-age=3600", ...cors(env) } });
}

const CARD_MAX_BYTES = 1_500_000;
const CARD_COOLDOWN_MS = 30_000;

async function handleCard(req: Request, env: Env): Promise<Response> {
  const user = await authUser(req, env);
  if (!user) return json(env, { error: "unauthorized" }, 401);
  const now = Date.now();
  const p = await env.DB.prepare("SELECT last_card_at FROM players WHERE id = ?").bind(user.id).first<{ last_card_at: number }>();
  if (p && now - p.last_card_at < CARD_COOLDOWN_MS) return json(env, { error: "slow_down" }, 429);

  const bytes = await req.arrayBuffer();
  const sig = new Uint8Array(bytes.slice(0, 8));
  const isPng = sig.length === 8 && sig[0] === 0x89 && sig[1] === 0x50 && sig[2] === 0x4e && sig[3] === 0x47;
  if (!isPng || bytes.byteLength > CARD_MAX_BYTES) return json(env, { error: "bad_image" }, 400);

  await env.DB.prepare("UPDATE players SET last_card_at = ? WHERE id = ?").bind(now, user.id).run();
  const url = env.WEBAPP_URL || new URL(req.url).origin;
  const username = await botUsername(env);
  const link = inviteLink(env, username, user.id);
  const caption =
    "🐹 Your Squeektoshi card. Forward it or save it and post it on X." +
    (link ? `\n\nYour invite link: ${esc(link)}` : "");
  const r = await sendPhotoBytes(env.BOT_TOKEN, user.id, bytes, "squeektoshi-card.png", caption, [[{ text: "🐹 Spin the wheel", web_app: { url } }]]);
  if (r?.ok) return json(env, { sent: true });
  if (r?.error_code === 403 || r?.error_code === 400) {
    await env.DB.prepare("UPDATE players SET chat_ok = 0 WHERE id = ?").bind(user.id).run();
    return json(env, { sent: false, reason: "start_bot" });
  }
  return json(env, { sent: false, reason: "telegram" }, 502);
}

// ---------------------------------------------------------------- wallet

type WalletResult = { ok: true; wallet: string | null } | { ok: false; error: "format" | "checksum" | "zero" | "taken" };

/** Save (or with null/"" remove) the player's EVM wallet. One wallet per player, one player per wallet. */
async function setWallet(
  env: Env,
  u: { id: number; username?: string; first_name?: string },
  input: unknown,
  now: number,
): Promise<WalletResult> {
  await env.DB.prepare("INSERT OR IGNORE INTO players (id, username, first_name, created_at) VALUES (?, ?, ?, ?)")
    .bind(u.id, u.username ?? null, u.first_name ?? null, now)
    .run();
  if (input === null || input === "") {
    await env.DB.prepare("UPDATE players SET wallet = NULL, wallet_at = ? WHERE id = ?").bind(now, u.id).run();
    return { ok: true, wallet: null };
  }
  const c = checkAddress(input);
  if (!c.ok) return { ok: false, error: c.reason };
  const cur = await env.DB.prepare("SELECT wallet FROM players WHERE id = ?").bind(u.id).first<{ wallet: string | null }>();
  if (cur?.wallet === c.lower) return { ok: true, wallet: c.checksummed }; // unchanged: keep wallet_at
  try {
    await env.DB.prepare("UPDATE players SET wallet = ?, wallet_at = ? WHERE id = ?").bind(c.lower, now, u.id).run();
  } catch (e) {
    if (/UNIQUE/i.test(String(e))) return { ok: false, error: "taken" };
    throw e;
  }
  return { ok: true, wallet: c.checksummed };
}

const WALLET_ERRORS: Record<string, string> = {
  format: "That's not an EVM address. It should be 0x followed by 40 characters (0-9, a-f).",
  checksum: "The capital letters don't match the address checksum, so there's probably a typo. Copy it from your wallet again.",
  zero: "That's the zero address. Paste your own wallet.",
  taken: "This wallet is already linked to another player.",
};

async function handleWallet(req: Request, env: Env): Promise<Response> {
  const user = await authUser(req, env);
  if (!user) return json(env, { error: "unauthorized" }, 401);
  const body = (await req.json().catch(() => null)) as { address?: unknown } | null;
  if (!body || !("address" in body)) return json(env, { error: "bad_json" }, 400);
  const r = await setWallet(env, user, body.address, Date.now());
  if (!r.ok) return json(env, { error: r.error, message: WALLET_ERRORS[r.error] }, r.error === "taken" ? 409 : 400);
  return json(env, { wallet: r.wallet });
}

// ---------------------------------------------------------------- export (admins)

const adminIds = (env: Env) =>
  new Set(
    (env.ADMIN_IDS ?? "")
      .split(/[,\s]+/)
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0),
  );

/** Top-N for a window, with what a reviewer needs to judge each row (see wallet.ts exportFlags). */
async function exportRows(env: Env, scope: ExportScope, n: number, now: number): Promise<ExportRow[]> {
  const extra =
    "p.id, p.username, p.first_name, p.total_points AS all_points, p.ref_points, p.wallet, p.wallet_at, p.ref_by, p.created_at, " +
    "(SELECT COUNT(*) FROM players f WHERE f.ref_by = p.id) AS invites, " +
    "(SELECT COUNT(*) FROM players f WHERE f.ref_by = p.id AND f.total_revs > 0) AS active_invites, " +
    "(SELECT COUNT(*) FROM daily dd WHERE dd.player_id = p.id AND dd.revs > 0) AS days_played";
  if (scope === "all") {
    const r = await env.DB.prepare(
      `SELECT ${extra}, p.total_points AS points, p.total_revs AS revs FROM players p ` +
        "WHERE p.total_points > 0 ORDER BY p.total_points DESC, p.id LIMIT ?",
    )
      .bind(n)
      .all<ExportRow>();
    return r.results;
  }
  const since = utcDay(scope === "week" ? now - 6 * 86400_000 : now); // week = today + 6 previous UTC days
  const r = await env.DB.prepare(
    `SELECT ${extra}, s.points, s.revs FROM ` +
      "(SELECT player_id, SUM(points) AS points, SUM(revs) AS revs FROM daily WHERE day >= ? GROUP BY player_id) s " +
      "JOIN players p ON p.id = s.player_id WHERE s.points > 0 ORDER BY s.points DESC, p.id LIMIT ?",
  )
    .bind(since, n)
    .all<ExportRow>();
  return r.results;
}

// ---------------------------------------------------------------- API handlers

/** Everything the app shows about the current player, in one call (used on open). */
async function handleMe(req: Request, env: Env): Promise<Response> {
  const user = await authUser(req, env);
  if (!user) return json(env, { error: "unauthorized" }, 401);
  const day = utcDay(Date.now());
  const db = env.DB;
  const [p, d, friends, username] = await Promise.all([
    db.prepare("SELECT total_revs, total_points, ref_points, notify, chat_ok, wallet FROM players WHERE id = ?")
      .bind(user.id)
      .first<{ total_revs: number; total_points: number; ref_points: number; notify: number; chat_ok: number; wallet: string | null }>(),
    db.prepare("SELECT revs, points FROM daily WHERE day = ? AND player_id = ?")
      .bind(day, user.id)
      .first<{ revs: number; points: number }>(),
    db.prepare("SELECT COUNT(*) AS n, SUM(CASE WHEN total_revs > 0 THEN 1 ELSE 0 END) AS active FROM players WHERE ref_by = ?")
      .bind(user.id)
      .first<{ n: number; active: number | null }>(),
    botUsername(env),
  ]);
  const todayPoints = d?.points ?? 0;
  return json(env, {
    day,
    today: { revs: d?.revs ?? 0, points: todayPoints, rank: todayPoints > 0 ? await rankFor(env, "today", day, todayPoints) : null },
    total: { revs: p?.total_revs ?? 0, points: p?.total_points ?? 0 },
    invites: { friends: friends?.n ?? 0, active: friends?.active ?? 0, bonusPoints: p?.ref_points ?? 0, pct: REF_BONUS_PCT },
    inviteLink: inviteLink(env, username, user.id),
    alerts: { on: p?.notify === 1, chatOk: p ? p.chat_ok === 1 : false },
    wallet: p?.wallet ? toChecksum(p.wallet) : null,
  });
}

async function handleState(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const now = Date.now();
  const day = utcDay(now);
  ctx.waitUntil(ensureBotSetup(env, new URL(req.url).origin).catch((e) => console.error("setup", e)));
  const [h, g] = await Promise.all([hamsterNow(env, now), globalToday(env, day)]);
  return json(env, statePayload(h, g, day));
}

async function handleSpin(req: Request, env: Env): Promise<Response> {
  const user = await authUser(req, env);
  if (!user) return json(env, { error: "unauthorized" }, 401);

  let body: { revs?: unknown; seq?: unknown };
  try {
    body = await req.json();
  } catch {
    return json(env, { error: "bad_json" }, 400);
  }

  const now = Date.now();
  const day = utcDay(now);
  const db = env.DB;

  let prev = await db
    .prepare("SELECT last_batch_at, last_seq, ref_by FROM players WHERE id = ?")
    .bind(user.id)
    .first<{ last_batch_at: number; last_seq: number; ref_by: number | null }>();
  if (!prev) {
    // First time we see this player: an invite link opened as a Mini App carries startapp=r<id>.
    await attachReferral(env, user, parseRef(user.startParam), now);
    await db
      .prepare(
        "INSERT OR IGNORE INTO players (id, username, first_name, created_at) VALUES (?, ?, ?, ?)",
      )
      .bind(user.id, user.username ?? null, user.first_name ?? null, now)
      .run();
    prev = await db
      .prepare("SELECT last_batch_at, last_seq, ref_by FROM players WHERE id = ?")
      .bind(user.id)
      .first<{ last_batch_at: number; last_seq: number; ref_by: number | null }>();
  }
  const lastSeq = prev?.last_seq ?? 0;
  const lastBatchAt = prev?.last_batch_at ?? 0;

  const verdict = acceptBatch({ claimedRevs: body.revs, seq: body.seq, lastSeq, lastBatchAt, now });
  if (!verdict.ok) return json(env, { error: verdict.reason, lastSeq }, verdict.reason === "replay" ? 409 : 400);

  const h = await hamsterNow(env, now);
  const boost = boostMilli(h.running, h.rpm);
  const revs = verdict.accepted;
  const points = pointsFor(revs, boost);

  // Compare-and-swap on last_seq: two concurrent batches can't both pass.
  const upd = await db
    .prepare(
      "UPDATE players SET total_revs = total_revs + ?, total_points = total_points + ?, " +
        "last_batch_at = ?, last_seq = ?, username = ?, first_name = ? WHERE id = ? AND last_seq = ?",
    )
    .bind(revs, points, now, body.seq, user.username ?? null, user.first_name ?? null, user.id, lastSeq)
    .run();
  if (!upd.meta.changes) return json(env, { error: "replay", lastSeq }, 409);

  if (revs > 0) {
    const writes = [
      db
        .prepare(
          "INSERT INTO daily (day, player_id, revs, points) VALUES (?, ?, ?, ?) " +
            "ON CONFLICT(day, player_id) DO UPDATE SET revs = revs + excluded.revs, points = points + excluded.points",
        )
        .bind(day, user.id, revs, points),
      db
        .prepare(
          "INSERT INTO global_daily (day, human_revs, human_points, updated_at) VALUES (?, ?, ?, ?) " +
            "ON CONFLICT(day) DO UPDATE SET human_revs = human_revs + excluded.human_revs, " +
            "human_points = human_points + excluded.human_points, updated_at = excluded.updated_at",
        )
        .bind(day, revs, points, now),
    ];
    // Inviter's cut: REF_BONUS_PCT% of what this friend just earned.
    const bonus = prev?.ref_by ? refBonus(points) : 0;
    if (prev?.ref_by && bonus > 0) {
      writes.push(
        db
          .prepare("UPDATE players SET total_points = total_points + ?, ref_points = ref_points + ? WHERE id = ?")
          .bind(bonus, bonus, prev.ref_by),
        db
          .prepare(
            "INSERT INTO daily (day, player_id, revs, points) VALUES (?, ?, 0, ?) " +
              "ON CONFLICT(day, player_id) DO UPDATE SET points = points + excluded.points",
          )
          .bind(day, prev.ref_by, bonus),
      );
    }
    await db.batch(writes);
  }

  const [me, g] = await Promise.all([
    db
      .prepare(
        "SELECT p.total_revs, p.total_points, COALESCE(d.revs, 0) AS today_revs, COALESCE(d.points, 0) AS today_points " +
          "FROM players p LEFT JOIN daily d ON d.player_id = p.id AND d.day = ? WHERE p.id = ?",
      )
      .bind(day, user.id)
      .first<{ total_revs: number; total_points: number; today_revs: number; today_points: number }>(),
    globalToday(env, day),
  ]);

  return json(env, {
    accepted: revs,
    capped: verdict.capped,
    seq: body.seq,
    me,
    ...statePayload(h, g, day),
  });
}

async function handleLeaderboard(req: Request, env: Env): Promise<Response> {
  const scope = new URL(req.url).searchParams.get("scope") === "all" ? "all" : "today";
  const day = utcDay(Date.now());
  const rows =
    scope === "all"
      ? await env.DB.prepare(
          "SELECT id, username, first_name, total_revs AS revs, total_points AS points FROM players " +
            "WHERE total_points > 0 ORDER BY total_points DESC LIMIT 20",
        ).all()
      : await env.DB.prepare(
          "SELECT p.id, p.username, p.first_name, d.revs, d.points FROM daily d JOIN players p ON p.id = d.player_id " +
            "WHERE d.day = ? AND d.points > 0 ORDER BY d.points DESC LIMIT 20",
        )
          .bind(day)
          .all();

  const user = await authUser(req, env);

  // The caller's own place, even when they're outside the top 20.
  let me: { rank: number; points: number; revs: number } | null = null;
  if (user) {
    const mine =
      scope === "all"
        ? await env.DB.prepare("SELECT total_points AS points, total_revs AS revs FROM players WHERE id = ?")
            .bind(user.id)
            .first<{ points: number; revs: number }>()
        : await env.DB.prepare("SELECT points, revs FROM daily WHERE day = ? AND player_id = ?")
            .bind(day, user.id)
            .first<{ points: number; revs: number }>();
    if (mine && mine.points > 0) {
      me = { rank: await rankFor(env, scope, day, mine.points), points: mine.points, revs: mine.revs };
    }
  }

  return json(env, {
    scope,
    day,
    me,
    top: (rows.results as any[]).map((r, i) => ({
      rank: i + 1,
      name: displayName(r),
      revs: r.revs,
      points: r.points,
      me: user ? r.id === user.id : false,
    })),
  });
}

// ---------------------------------------------------------------- Telegram bot

async function topText(env: Env, day: string): Promise<string> {
  const rows = await env.DB.prepare(
    "SELECT p.id, p.username, p.first_name, d.points FROM daily d JOIN players p ON p.id = d.player_id " +
      "WHERE d.day = ? AND d.points > 0 ORDER BY d.points DESC LIMIT 10",
  )
    .bind(day)
    .all();
  const lines = (rows.results as any[]).map(
    (r, i) => `${i + 1}. ${esc(displayName(r))} — ${r.points.toLocaleString("en-US")}`,
  );
  return `🏆 <b>Today's top spinners</b> (${day} UTC)\n\n${lines.join("\n") || "Nobody yet. Be first."}`;
}

async function hamsterText(env: Env, now: number): Promise<string> {
  const h = await hamsterNow(env, now);
  const g = await globalToday(env, utcDay(now));
  const line =
    h.signal === "none"
      ? "📡 No signal from the wheel right now."
      : h.fault
        ? "⚠️ Wheel counter fault."
        : h.running
          ? `🏃 Squeektoshi is RUNNING — ${h.rpm.toFixed(0)} rpm. Boost ×${(boostMilli(true, h.rpm) / 1000).toFixed(1)}`
          : "😴 Squeektoshi is asleep. Night shift is on.";
  return `${line}\n\nToday: humans ${humanWork(g.human_revs).toFixed(2)} vs hamster ${g.hamster_work} work units`;
}

/** /wallet, /wallet 0x..., /wallet off */
async function walletCommand(
  env: Env,
  from: { id: number; username?: string; first_name?: string },
  arg: string | undefined,
  now: number,
): Promise<string> {
  if (!arg) {
    const p = await env.DB.prepare("SELECT wallet FROM players WHERE id = ?").bind(from.id).first<{ wallet: string | null }>();
    return p?.wallet
      ? `👛 Your wallet: <code>${toChecksum(p.wallet)}</code>\n\nChange: /wallet 0xNEW…\nRemove: /wallet off`
      : "👛 No wallet yet. Send <code>/wallet 0xYourAddress</code> (any EVM wallet).\n\n" +
          "<i>If the Squeekchain team ever rewards top spinners, this is where it goes. Nothing is promised.</i>";
  }
  const off = ["off", "remove", "delete", "none"].includes(arg.toLowerCase());
  const r = await setWallet(env, from, off ? null : arg, now);
  if (!r.ok) return `⚠️ ${WALLET_ERRORS[r.error]}`;
  return r.wallet ? `✅ Wallet saved: <code>${r.wallet}</code> (${shortAddr(r.wallet)})` : "Wallet removed.";
}

async function handleWebhook(req: Request, env: Env): Promise<Response> {
  if (req.headers.get("x-telegram-bot-api-secret-token") !== env.WEBHOOK_SECRET) {
    return new Response("forbidden", { status: 403 });
  }
  const update = (await req.json().catch(() => null)) as any;
  const now = Date.now();
  const origin = new URL(req.url).origin; // Telegram calls us on our own origin
  const url = env.WEBAPP_URL || origin;
  const t = env.BOT_TOKEN;

  // Inline buttons under bot messages ("🏆 Top", "🐹 Is he running?")
  const cb = update?.callback_query;
  if (cb) {
    await tgCall(t, "answerCallbackQuery", { callback_query_id: cb.id });
    const chatId = cb.message?.chat?.id;
    if (chatId && cb.data === "top") await sendMessage(t, chatId, await topText(env, utcDay(now)), [[{ text: "🐹 Spin the wheel", web_app: { url } }]]);
    if (chatId && cb.data === "hamster") await sendMessage(t, chatId, await hamsterText(env, now), [[{ text: "🐹 Spin the wheel", web_app: { url } }]]);
    if (chatId && cb.from?.id && (cb.data === "alerts_on" || cb.data === "alerts_off")) {
      const on = cb.data === "alerts_on";
      await setNotify(env, cb.from, on, now);
      await sendMessage(t, chatId, alertsText(on));
    }
    return new Response("ok");
  }

  const msg = update?.message;
  const text: string = msg?.text ?? "";
  const chatId = msg?.chat?.id;
  if (!chatId || !text.startsWith("/")) return new Response("ok");

  const args = text.trim().split(/\s+/);
  const cmdRaw = args[0];
  const payload: string | undefined = args[1];
  const cmd = cmdRaw.split("@")[0].toLowerCase();
  const isPrivate = msg.chat.type === "private";
  const from = msg.from as { id: number; username?: string; first_name?: string } | undefined;
  const spin: InlineButton = isPrivate ? { text: "🐹 Spin the wheel", web_app: { url } } : spinButton(env, url);
  const username = await botUsername(env);
  const myLink = from ? inviteLink(env, username, from.id) : null;

  if (cmd === "/start") {
    let invited = false;
    if (isPrivate && from) {
      invited = await attachReferral(env, from, parseRef(payload), now);
      // Make sure the player exists so their own invite link works right away.
      await env.DB.prepare(
        "INSERT OR IGNORE INTO players (id, username, first_name, created_at) VALUES (?, ?, ?, ?)",
      )
        .bind(from.id, from.username ?? null, from.first_name ?? null, now)
        .run();
      // They opened a private chat with the bot, so we can message them now.
      await env.DB.prepare("UPDATE players SET chat_ok = 1 WHERE id = ?").bind(from.id).run();
    }
    const caption =
      `🐹 <b>${BOT_NAME}</b>\n\n` +
      "Squeektoshi is a real hamster mining Squeekchain on his wheel. Spin yours with him.\n\n" +
      "• He's running → his live rpm boosts every spin\n" +
      "• He's asleep → night shift: 1,000 human spins = 1 hamster turn\n" +
      `• Invite friends → you get +${REF_BONUS_PCT}% of their points\n\n` +
      (invited ? "✅ You joined through a friend's invite.\n\n" : "") +
      "<i>Community game on Squeekchain's public data. Not affiliated with Squeekchain.</i>";
    const keyboard: InlineButton[][] = [[spin]];
    if (isPrivate) {
      const row: InlineButton[] = [];
      if (myLink) row.push({ text: "👥 Invite friends", url: shareUrl(myLink) });
      row.push({ text: "🏆 Top", callback_data: "top" });
      keyboard.push(row);
      keyboard.push([{ text: "🔔 Ping me when he runs", callback_data: "alerts_on" }]);
    }
    const sent = (await sendPhoto(t, chatId, `${origin}/welcome.png`, caption, keyboard)) as { ok?: boolean } | null;
    if (!sent?.ok) await sendMessage(t, chatId, caption, keyboard); // e.g. image not deployed yet
  } else if (cmd === "/hamster") {
    await sendMessage(t, chatId, await hamsterText(env, now), [[spin]]);
  } else if (cmd === "/top") {
    await sendMessage(t, chatId, await topText(env, utcDay(now)), [[spin]]);
  } else if (cmd === "/alerts" && isPrivate && from) {
    const on = (payload ?? "on").toLowerCase() !== "off";
    await setNotify(env, from, on, now);
    await sendMessage(t, chatId, alertsText(on), [[on ? { text: "Turn off", callback_data: "alerts_off" } : { text: "Turn on", callback_data: "alerts_on" }]]);
  } else if (cmd === "/invite" && isPrivate && from) {
    if (!myLink) {
      await sendMessage(t, chatId, "Invite links will be ready in a minute. Try /invite again shortly.");
    } else {
      await sendMessage(
        t,
        chatId,
        `👥 <b>Your invite link</b>\n\n${esc(myLink)}\n\nFriends who join through it give you +${REF_BONUS_PCT}% of every point they spin.`,
        [[{ text: "Share", url: shareUrl(myLink) }], [spin]],
      );
    }
  } else if (cmd === "/wallet" && isPrivate && from) {
    await sendMessage(t, chatId, await walletCommand(env, from, payload, now));
  } else if (cmd === "/myid" && isPrivate && from) {
    await sendMessage(t, chatId, `Your Telegram id: <code>${from.id}</code>`);
  } else if (cmd === "/export" && isPrivate && from && adminIds(env).has(from.id)) {
    const scope = parseScope(payload);
    const n = parseN(args[2]);
    const rows = await exportRows(env, scope, n, now);
    const withWallet = rows.filter((r) => r.wallet).length;
    const stamp = new Date(now).toISOString().slice(0, 16).replace(/[:T]/g, "-");
    const caption =
      `📋 Top ${rows.length} by ${scope === "all" ? "all-time" : scope === "week" ? "last 7 days" : "today's"} points, ` +
      `${withWallet} with a wallet. ${new Date(now).toISOString().slice(0, 16).replace("T", " ")} UTC\n\n` +
      "Flags: operator · no_wallet · ref_heavy (>50% of points from invites) · inviter_in_top · wallet_recent (<24 h) · one_day";
    const r = await sendDocumentText(t, chatId, toCsv(rows, { adminIds: adminIds(env), now }), `squeektoshi-top-${scope}-${stamp}.csv`, "text/csv", caption);
    if (!r?.ok) await sendMessage(t, chatId, "Couldn't send the export. Try again in a minute.");
  }
  return new Response("ok");
}

// ---------------------------------------------------------------- cron

async function everyMinute(env: Env) {
  const now = Date.now();
  const day = utcDay(now);
  const h = await getHamster(env.STATUS_URL, now);
  const db = env.DB;
  const writes: D1PreparedStatement[] = [];

  if (h.signal !== "none") writes.push(kvPut(db, "hamster_last", h, now));

  // 1) Count hamster work for today from the live counter.
  if (h.work !== null && h.epoch !== null) {
    const anchor = await kvGet<{ epoch: string; work: number }>(db, "hamster_anchor");
    const delta = hamsterDelta(anchor, { epoch: h.epoch, work: h.work });
    writes.push(kvPut(db, "hamster_anchor", { epoch: h.epoch, work: h.work }, now));
    if (delta > 0) {
      writes.push(
        db
          .prepare(
            "INSERT INTO global_daily (day, hamster_work, updated_at) VALUES (?, ?, ?) " +
              "ON CONFLICT(day) DO UPDATE SET hamster_work = hamster_work + excluded.hamster_work, updated_at = excluded.updated_at",
          )
          .bind(day, delta, now),
      );
    }
  }

  // 2) Wake / sleep alerts.
  const machine = (await kvGet<WakeMachine>(db, "wake")) ?? { state: "unknown", since: now, streak: 0 };
  const running = h.signal === "live" ? h.running : null;
  const { next, event } = stepWake(machine, running, now);
  writes.push(kvPut(db, "wake", next, now));

  if (writes.length) await db.batch(writes);

  if (event && env.ALERT_CHAT_ID && env.BOT_TOKEN) {
    const text =
      event.kind === "woke"
        ? `🐹 <b>Squeektoshi woke up</b> and is running (${h.rpm.toFixed(0)} rpm).\nSpin with him now: boost ×${(boostMilli(true, h.rpm) / 1000).toFixed(1)}`
        : `😴 <b>Squeektoshi went to sleep</b> after ~${Math.max(1, Math.round(event.ranMs / 60000))} min of running.\nNight shift starts: 1000 human spins = 1 hamster turn.`;
    await sendMessage(env.BOT_TOKEN, env.ALERT_CHAT_ID, text, [[spinButton(env, await appUrl(env))]]);
  }

  // 3) "He's running" pings to players who opted in, PING_BATCH per run.
  const run = nextPingRun(await kvGet<PingRun>(db, "ping_run"), next.state, event?.kind === "woke", now);
  if (!run) {
    await db.prepare("DELETE FROM kv WHERE key = 'ping_run'").run();
  } else if (!run.done && env.BOT_TOKEN) {
    await sendPingBatch(env, run, h, now);
    await kvPut(db, "ping_run", run, now).run();
  }
}

async function sendPingBatch(env: Env, run: PingRun, h: HamsterState, now: number) {
  const rows = await env.DB.prepare(
    "SELECT id FROM players WHERE notify = 1 AND chat_ok = 1 AND id > ? AND last_ping_at < ? ORDER BY id LIMIT ?",
  )
    .bind(run.cursor, now - PING_COOLDOWN_MS, PING_BATCH)
    .all<{ id: number }>();
  const ids = rows.results.map((r) => r.id);
  if (ids.length < PING_BATCH) run.done = true;
  if (!ids.length) return;
  run.cursor = ids[ids.length - 1];

  const url = await appUrl(env);
  const boost = (boostMilli(true, h.rpm) / 1000).toFixed(1);
  const text =
    `🐹 <b>Squeektoshi is running!</b>\nEvery spin counts ×${boost} while he runs. Spin with him now.\n\n` +
    "<i>/alerts off to stop these pings</i>";
  const sent: number[] = [];
  const blocked: number[] = [];
  for (let i = 0; i < ids.length; i += 20) {
    // 20 at a time keeps us under Telegram's ~30 messages/second
    const chunk = ids.slice(i, i + 20);
    const res = await Promise.all(
      chunk.map((id) => sendMessage(env.BOT_TOKEN, id, text, url ? [[{ text: "🐹 Spin now", web_app: { url } }]] : undefined)),
    );
    res.forEach((r: any, j) => {
      if (r?.ok) sent.push(chunk[j]);
      else if (r?.error_code === 403 || r?.error_code === 400) blocked.push(chunk[j]); // blocked the bot / never started it
    });
  }
  const db = env.DB;
  const writes = [
    ...sent.map((id) => db.prepare("UPDATE players SET last_ping_at = ? WHERE id = ?").bind(now, id)),
    ...blocked.map((id) => db.prepare("UPDATE players SET chat_ok = 0 WHERE id = ?").bind(id)),
  ];
  if (writes.length) await db.batch(writes);
}

async function dailyRecap(env: Env) {
  if (!env.ALERT_CHAT_ID || !env.BOT_TOKEN) return;
  const now = Date.now();
  const yesterday = utcDay(now - 24 * 60 * 60 * 1000);
  const g = await env.DB.prepare(
    "SELECT human_revs, hamster_work, recap_sent FROM global_daily WHERE day = ?",
  )
    .bind(yesterday)
    .first<{ human_revs: number; hamster_work: number; recap_sent: number }>();
  if (!g || g.recap_sent) return;

  const top = await env.DB.prepare(
    "SELECT p.id, p.username, p.first_name, d.points FROM daily d JOIN players p ON p.id = d.player_id " +
      "WHERE d.day = ? AND d.points > 0 ORDER BY d.points DESC LIMIT 3",
  )
    .bind(yesterday)
    .all();
  const players = await env.DB.prepare("SELECT COUNT(*) AS n FROM daily WHERE day = ? AND revs > 0")
    .bind(yesterday)
    .first<{ n: number }>();

  const hw = humanWork(g.human_revs);
  const verdict =
    hw >= g.hamster_work && g.human_revs > 0
      ? "🧑‍🤝‍🧑 Humans out-ran the hamster. Respect."
      : g.hamster_work > 0
        ? `🐹 Squeektoshi wins. Humans would need ${Math.max(0, Math.ceil(g.hamster_work * 1000 - g.human_revs)).toLocaleString("en-US")} more spins.`
        : "Quiet day on the wheel.";
  const medals = ["🥇", "🥈", "🥉"];
  const podium = (top.results as any[])
    .map((r, i) => `${medals[i]} ${esc(displayName(r))} — ${r.points.toLocaleString("en-US")}`)
    .join("\n");

  const sent = (await sendMessage(
    env.BOT_TOKEN,
    env.ALERT_CHAT_ID,
    `📊 <b>Humans vs Hamster — ${yesterday}</b>\n\n` +
      `🐹 Hamster: ${g.hamster_work.toLocaleString("en-US")} work units\n` +
      `🧑 Humans: ${g.human_revs.toLocaleString("en-US")} spins = ${hw.toFixed(2)} work units (${players?.n ?? 0} players)\n\n` +
      `${verdict}\n\n${podium}`,
    [[spinButton(env, await appUrl(env))]],
  )) as { ok?: boolean } | null;
  // Only mark as sent on success: the cron retries every minute until 06:30 UTC.
  if (sent?.ok) {
    await env.DB.prepare("UPDATE global_daily SET recap_sent = 1 WHERE day = ?").bind(yesterday).run();
  }
}

// ---------------------------------------------------------------- entry

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(env) });
    try {
      if (pathname.startsWith("/api/") || pathname.startsWith("/tg/") || pathname.startsWith("/dev/")) {
        await ensureSchema(env.DB);
      }
      if (pathname === "/api/state" && req.method === "GET") return await handleState(req, env, ctx);
      if (pathname === "/api/spin" && req.method === "POST") return await handleSpin(req, env);
      if (pathname === "/api/me" && req.method === "GET") return await handleMe(req, env);
      if (pathname === "/api/notify" && req.method === "POST") return await handleNotify(req, env);
      if (pathname === "/api/avatar" && req.method === "GET") return await handleAvatar(req, env);
      if (pathname === "/api/card" && req.method === "POST") return await handleCard(req, env);
      if (pathname === "/api/wallet" && req.method === "POST") return await handleWallet(req, env);
      if (pathname === "/api/leaderboard" && req.method === "GET") return await handleLeaderboard(req, env);
      if (pathname === "/tg/webhook" && req.method === "POST") return await handleWebhook(req, env);
      // Local testing only (DEV_ALLOW_UNSIGNED=1): run the recap job on demand.
      if (pathname === "/dev/recap" && env.DEV_ALLOW_UNSIGNED === "1") {
        await dailyRecap(env);
        return json(env, { ok: true });
      }
      // Local testing only: the same CSV that /export sends admins in Telegram.
      if (pathname === "/dev/export" && env.DEV_ALLOW_UNSIGNED === "1") {
        const q = new URL(req.url).searchParams;
        const now = Date.now();
        const rows = await exportRows(env, parseScope(q.get("scope") ?? undefined), parseN(q.get("n") ?? undefined), now);
        return new Response(toCsv(rows, { adminIds: adminIds(env), now }), { headers: { "content-type": "text/csv" } });
      }
      // "/" is normally answered by the static mini-app; this only shows if assets are missing.
      if (pathname === "/") return new Response("squeektoshi worker ok");
      return json(env, { error: "not_found" }, 404);
    } catch (e) {
      console.error(e);
      return json(env, { error: "internal" }, 500);
    }
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    await ensureSchema(env.DB);
    ctx.waitUntil(everyMinute(env));
    // Yesterday's recap: tried every minute 06:00–06:30 UTC until Telegram accepts it.
    const d = new Date();
    if (d.getUTCHours() === 6 && d.getUTCMinutes() <= 30) ctx.waitUntil(dailyRecap(env));
  },
} satisfies ExportedHandler<Env>;
