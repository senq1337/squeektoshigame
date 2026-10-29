// Squeek Wheel — Cloudflare Worker
// Routes:
//   GET  /api/state                 live hamster + today's humans-vs-hamster score
//   POST /api/spin                  { revs, seq } + header X-Init-Data  -> accepted revs, my stats
//   GET  /api/leaderboard?scope=today|all
//   POST /tg/webhook                Telegram bot updates (/start, /top, /hamster)
// Cron:
//   every minute  poll hamster, count hamster work for the day, wake/sleep alerts;
//                 06:00–06:30 UTC also (re)tries yesterday's recap until it's delivered

import {
  acceptBatch,
  boostMilli,
  hamsterDelta,
  humanWork,
  pointsFor,
  stepWake,
  utcDay,
  type WakeMachine,
} from "./game";
import { getHamster, type HamsterState } from "./hamster";
import { esc, sendMessage, verifyInitData, type InlineButton, type TgUser } from "./telegram";

export interface Env {
  DB: D1Database;
  STATUS_URL: string;
  WEBAPP_URL: string;
  ALLOWED_ORIGIN: string;
  ALERT_CHAT_ID: string;
  DEV_ALLOW_UNSIGNED: string;
  APP_LINK?: string; // optional t.me/<bot>/<app> link for buttons in channels
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

const spinButton = (env: Env, text = "🐹 Spin the wheel"): InlineButton =>
  env.APP_LINK ? { text, url: env.APP_LINK } : { text, web_app: { url: env.WEBAPP_URL } };

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

// ---------------------------------------------------------------- API handlers

async function handleState(env: Env): Promise<Response> {
  const now = Date.now();
  const day = utcDay(now);
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

  const prev = await db
    .prepare("SELECT last_batch_at, last_seq FROM players WHERE id = ?")
    .bind(user.id)
    .first<{ last_batch_at: number; last_seq: number }>();
  if (!prev) {
    await db
      .prepare(
        "INSERT OR IGNORE INTO players (id, username, first_name, created_at) VALUES (?, ?, ?, ?)",
      )
      .bind(user.id, user.username ?? null, user.first_name ?? null, now)
      .run();
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
    await db.batch([
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
    ]);
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
      const ahead =
        scope === "all"
          ? await env.DB.prepare("SELECT COUNT(*) AS n FROM players WHERE total_points > ?")
              .bind(mine.points)
              .first<{ n: number }>()
          : await env.DB.prepare("SELECT COUNT(*) AS n FROM daily WHERE day = ? AND points > ?")
              .bind(day, mine.points)
              .first<{ n: number }>();
      me = { rank: (ahead?.n ?? 0) + 1, points: mine.points, revs: mine.revs };
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

async function handleWebhook(req: Request, env: Env): Promise<Response> {
  if (req.headers.get("x-telegram-bot-api-secret-token") !== env.WEBHOOK_SECRET) {
    return new Response("forbidden", { status: 403 });
  }
  const update = (await req.json().catch(() => null)) as any;
  const msg = update?.message;
  const text: string = msg?.text ?? "";
  const chatId = msg?.chat?.id;
  if (!chatId || !text.startsWith("/")) return new Response("ok");

  const cmd = text.split(/[\s@]/)[0].toLowerCase();
  const now = Date.now();
  const isPrivate = msg.chat.type === "private";
  const button = isPrivate
    ? ({ text: "🐹 Spin the wheel", web_app: { url: env.WEBAPP_URL } } as InlineButton)
    : spinButton(env);

  if (cmd === "/start") {
    await sendMessage(
      env.BOT_TOKEN,
      chatId,
      "🐹 <b>Squeek Wheel</b>\n\n" +
        "Squeektoshi mines blocks on a real wheel. Spin yours with him.\n\n" +
        "• He's running → his live rpm boosts every spin\n" +
        "• He's asleep → night shift: humans keep the wheel going, but 1000 human spins = 1 hamster turn\n\n" +
        "/top — leaderboard · /hamster — is he running?",
      [[button]],
    );
  } else if (cmd === "/hamster") {
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
    await sendMessage(
      env.BOT_TOKEN,
      chatId,
      `${line}\n\nToday: humans ${humanWork(g.human_revs).toFixed(2)} vs hamster ${g.hamster_work} work units`,
      [[button]],
    );
  } else if (cmd === "/top") {
    const day = utcDay(now);
    const rows = await env.DB.prepare(
      "SELECT p.id, p.username, p.first_name, d.points FROM daily d JOIN players p ON p.id = d.player_id " +
        "WHERE d.day = ? AND d.points > 0 ORDER BY d.points DESC LIMIT 10",
    )
      .bind(day)
      .all();
    const lines = (rows.results as any[]).map(
      (r, i) => `${i + 1}. ${esc(displayName(r))} — ${r.points.toLocaleString("en-US")}`,
    );
    await sendMessage(
      env.BOT_TOKEN,
      chatId,
      `🏆 <b>Today's top spinners</b> (${day} UTC)\n\n${lines.join("\n") || "Nobody yet. Be first."}`,
      [[button]],
    );
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
    await sendMessage(env.BOT_TOKEN, env.ALERT_CHAT_ID, text, [[spinButton(env)]]);
  }
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
    [[spinButton(env)]],
  )) as { ok?: boolean } | null;
  // Only mark as sent on success: the cron retries every minute until 06:30 UTC.
  if (sent?.ok) {
    await env.DB.prepare("UPDATE global_daily SET recap_sent = 1 WHERE day = ?").bind(yesterday).run();
  }
}

// ---------------------------------------------------------------- entry

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(env) });
    try {
      if (pathname === "/api/state" && req.method === "GET") return await handleState(env);
      if (pathname === "/api/spin" && req.method === "POST") return await handleSpin(req, env);
      if (pathname === "/api/leaderboard" && req.method === "GET") return await handleLeaderboard(req, env);
      if (pathname === "/tg/webhook" && req.method === "POST") return await handleWebhook(req, env);
      // Local testing only (DEV_ALLOW_UNSIGNED=1): run the recap job on demand.
      if (pathname === "/dev/recap" && env.DEV_ALLOW_UNSIGNED === "1") {
        await dailyRecap(env);
        return json(env, { ok: true });
      }
      if (pathname === "/") return new Response("squeek-wheel ok");
      return json(env, { error: "not_found" }, 404);
    } catch (e) {
      console.error(e);
      return json(env, { error: "internal" }, 500);
    }
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(everyMinute(env));
    // Yesterday's recap: tried every minute 06:00–06:30 UTC until Telegram accepts it.
    const d = new Date();
    if (d.getUTCHours() === 6 && d.getUTCMinutes() <= 30) ctx.waitUntil(dailyRecap(env));
  },
} satisfies ExportedHandler<Env>;
