// Pure game rules. No I/O here, so everything is unit-testable.

/** Humans need this many wheel revolutions to equal one hamster work unit (one magnet pass). */
export const HUMAN_REVS_PER_HAMSTER_WORK = 1000;

/**
 * Server-side speed limit for a human wheel, in revolutions per second.
 * The client caps its wheel at 5 rev/s; 6 leaves room for network jitter.
 */
export const MAX_REVS_PER_SEC = 6;

/** Longest stretch of time one batch may claim. Stops "banking" idle time into one big batch. */
export const MAX_BATCH_WINDOW_MS = 15_000;

/** Window credited to a player's very first batch (no previous timestamp to measure from). */
export const FIRST_BATCH_WINDOW_MS = 5_000;

/** Boost while the hamster runs: 1 + rpm / RPM_PER_BOOST_STEP, capped at MAX_BOOST. */
export const RPM_PER_BOOST_STEP = 20;
export const MAX_BOOST = 7;

export interface BatchInput {
  claimedRevs: unknown; // straight from the request body, validated here
  seq: unknown;
  lastSeq: number;
  lastBatchAt: number; // unix ms, 0 = never
  now: number; // unix ms
}

export type BatchResult =
  | { ok: true; accepted: number; capped: boolean }
  | { ok: false; reason: "bad_input" | "replay" };

/**
 * Decide how many of the claimed revolutions to accept.
 * The cap is physical: a wheel can't turn faster than MAX_REVS_PER_SEC,
 * so a batch can never carry more than (time since the last batch) x that speed.
 */
export function acceptBatch(input: BatchInput): BatchResult {
  const { claimedRevs, seq, lastSeq, lastBatchAt, now } = input;
  if (typeof claimedRevs !== "number" || !Number.isFinite(claimedRevs) || claimedRevs < 0) {
    return { ok: false, reason: "bad_input" };
  }
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1) {
    return { ok: false, reason: "bad_input" };
  }
  if (seq <= lastSeq) return { ok: false, reason: "replay" };

  const elapsed =
    lastBatchAt > 0
      ? Math.min(Math.max(now - lastBatchAt, 0), MAX_BATCH_WINDOW_MS)
      : FIRST_BATCH_WINDOW_MS;
  const cap = Math.floor((elapsed / 1000) * MAX_REVS_PER_SEC);
  const claimed = Math.floor(claimedRevs);
  const accepted = Math.min(claimed, cap);
  return { ok: true, accepted, capped: accepted < claimed };
}

/** Boost in thousandths (1000 = x1), so points stay integers. */
export function boostMilli(hamsterRunning: boolean, rpm: number): number {
  if (!hamsterRunning || !(rpm > 0)) return 1000;
  const boost = Math.min(1 + rpm / RPM_PER_BOOST_STEP, MAX_BOOST);
  return Math.round(boost * 1000);
}

export function pointsFor(revs: number, boost: number): number {
  return Math.floor((revs * boost) / 1000);
}

/** Human revolutions expressed in hamster work units (1000 revs = 1 unit). */
export function humanWork(revs: number): number {
  return revs / HUMAN_REVS_PER_HAMSTER_WORK;
}

// ---- Referrals -------------------------------------------------------------

/** The inviter earns this % of every point their friend earns (from real, speed-capped spins). */
export const REF_BONUS_PCT = 10;

export function refBonus(points: number): number {
  return Math.floor((points * REF_BONUS_PCT) / 100);
}

/** "r123456" -> 123456 (a referral payload from /start or startapp), else null. */
export function parseRef(payload: string | null | undefined): number | null {
  const m = /^r(\d{1,15})$/.exec(payload ?? "");
  if (!m) return null;
  const id = Number(m[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Hamster work counted between two readings of the live counter.
 * The counter belongs to an epoch; if the epoch changes or the counter goes backwards
 * (device restart / counter reset) we re-anchor and count nothing for that step.
 */
export function hamsterDelta(
  anchor: { epoch: string; work: number } | null,
  current: { epoch: string; work: number },
): number {
  if (!anchor || anchor.epoch !== current.epoch || current.work < anchor.work) return 0;
  return current.work - anchor.work;
}

// ---- Wake / sleep detector -------------------------------------------------

export type WheelState = "awake" | "asleep" | "unknown";

export interface WakeMachine {
  state: WheelState;
  since: number; // when the current state was confirmed (unix ms)
  streak: number; // consecutive observations that disagree with `state`
}

/** Readings needed before we announce a change. Cron runs once a minute. */
export const WAKE_CONFIRM_READINGS = 2; // ~2 min of running
export const SLEEP_CONFIRM_READINGS = 10; // ~10 min of no running (short naps don't count)

export type WakeEvent = { kind: "woke" } | { kind: "slept"; ranMs: number } | null;

/**
 * Feed one observation (running = true/false, or null when there's no signal).
 * Returns the next machine state and an event when a change is confirmed.
 */
export function stepWake(
  m: WakeMachine,
  running: boolean | null,
  now: number,
): { next: WakeMachine; event: WakeEvent } {
  if (running === null) return { next: m, event: null }; // no signal: change nothing

  const observed: WheelState = running ? "awake" : "asleep";
  if (m.state === "unknown") {
    // First real reading: adopt it silently, no alert.
    return { next: { state: observed, since: now, streak: 0 }, event: null };
  }
  if (observed === m.state) return { next: { ...m, streak: 0 }, event: null };

  const streak = m.streak + 1;
  const needed = observed === "awake" ? WAKE_CONFIRM_READINGS : SLEEP_CONFIRM_READINGS;
  if (streak < needed) return { next: { ...m, streak }, event: null };

  const event: WakeEvent =
    observed === "awake" ? { kind: "woke" } : { kind: "slept", ranMs: now - m.since };
  return { next: { state: observed, since: now, streak: 0 }, event };
}
