// Reads Squeekchain's public live status feed and turns it into a small, stable shape.
//
// Feed: GET https://api.squeekchain.com/v1/status (observed 29.10.2026, schemaVersion 1)
//   measurement.freshness        "online" | ...           (device connectivity)
//   measurement.observedAt       ISO time of the last sensor reading
//   measurement.staleAfterSeconds after this, the reading is stale
//   measurement.coreStatus       "IDLE" | "ACTIVE" | "COUNTER_FAULT"
//   measurement.rpmMilli         wheel rpm x 1000
//   measurement.speedMmPerSecond / distanceMm
//   measurement.cumulativeWorkUnits / counterEpoch  (live work counter + its epoch)
//   builder.projected.blockHeight
// The official app treats the wheel as running when coreStatus is ACTIVE or rpm/speed > 0.

export interface HamsterState {
  signal: "live" | "stale" | "none"; // none = feed unreachable
  running: boolean;
  fault: boolean;
  rpm: number;
  speedMmS: number;
  distanceMm: number;
  work: number | null; // cumulative work units (live counter)
  epoch: string | null;
  blockHeight: number | null;
  observedAt: string | null;
  fetchedAt: number; // unix ms when we got it
}

export const NO_SIGNAL = (now: number): HamsterState => ({
  signal: "none",
  running: false,
  fault: false,
  rpm: 0,
  speedMmS: 0,
  distanceMm: 0,
  work: null,
  epoch: null,
  blockHeight: null,
  observedAt: null,
  fetchedAt: now,
});

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Pure: raw /v1/status JSON -> HamsterState. Unknown shapes degrade to "stale", never throw. */
export function normalizeStatus(raw: unknown, now: number): HamsterState {
  const r = (raw ?? {}) as Record<string, any>;
  const m = (r.measurement ?? {}) as Record<string, any>;
  const observedAt = typeof m.observedAt === "string" ? m.observedAt : null;
  const staleAfterMs = (num(m.staleAfterSeconds) || 120) * 1000;
  const age = observedAt ? now - Date.parse(observedAt) : Infinity;
  const fresh = m.freshness === "online" && age <= staleAfterMs;

  const fault = m.coreStatus === "COUNTER_FAULT";
  const rpm = num(m.rpmMilli) / 1000;
  const speedMmS = num(m.speedMmPerSecond);
  const running = fresh && !fault && (m.coreStatus === "ACTIVE" || rpm > 0 || speedMmS > 0);

  return {
    signal: fresh ? "live" : "stale",
    running,
    fault,
    rpm: running ? rpm : 0,
    speedMmS: running ? speedMmS : 0,
    distanceMm: num(m.distanceMm),
    work: typeof m.cumulativeWorkUnits === "number" ? m.cumulativeWorkUnits : null,
    epoch: typeof m.counterEpoch === "string" ? m.counterEpoch : null,
    blockHeight:
      typeof r.builder?.projected?.blockHeight === "number" ? r.builder.projected.blockHeight : null,
    observedAt,
    fetchedAt: now,
  };
}

// Per-isolate memory cache so a burst of players doesn't hammer the feed.
let memo: HamsterState | null = null;
const MEMO_TTL_MS = 10_000; // be polite to their API: ~1 call per 10 s per isolate, plus edge cache below

/**
 * Live hamster state, cached ~10 s. Never throws: on failure returns the last good state
 * (marked stale) or NO_SIGNAL. `loadFallback` (only called on failure) returns the last
 * state persisted by the cron job.
 */
export async function getHamster(
  statusUrl: string,
  now: number,
  loadFallback: () => Promise<HamsterState | null> = async () => null,
): Promise<HamsterState> {
  if (memo && now - memo.fetchedAt < MEMO_TTL_MS) return memo;
  try {
    const res = await fetch(statusUrl, {
      headers: { accept: "application/json", "user-agent": "squeek-wheel/0.1" },
      cf: { cacheTtl: 10, cacheEverything: true }, // shared per Cloudflare location
    } as RequestInit);
    if (!res.ok) throw new Error(`status ${res.status}`);
    memo = normalizeStatus(await res.json(), now);
    return memo;
  } catch {
    const last = memo ?? (await loadFallback().catch(() => null));
    if (last) return { ...last, signal: last.signal === "none" ? "none" : "stale", running: false, rpm: 0 };
    return NO_SIGNAL(now);
  }
}

/** For tests. */
export function _resetMemo() {
  memo = null;
}
