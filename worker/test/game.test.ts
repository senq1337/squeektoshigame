import { describe, expect, it } from "vitest";
import {
  acceptBatch,
  nextPingRun,
  parseRef,
  refBonus,
  boostMilli,
  FIRST_BATCH_WINDOW_MS,
  hamsterDelta,
  MAX_BATCH_WINDOW_MS,
  MAX_REVS_PER_SEC,
  pointsFor,
  SLEEP_CONFIRM_READINGS,
  stepWake,
  WAKE_CONFIRM_READINGS,
  type WakeMachine,
} from "../src/game";

const T0 = 1_800_000_000_000;

describe("acceptBatch", () => {
  it("accepts a normal batch within the speed limit", () => {
    const r = acceptBatch({ claimedRevs: 12, seq: 2, lastSeq: 1, lastBatchAt: T0, now: T0 + 3000 });
    expect(r).toEqual({ ok: true, accepted: 12, capped: false });
  });

  it("caps a batch at MAX_REVS_PER_SEC x elapsed", () => {
    const r = acceptBatch({ claimedRevs: 1000, seq: 2, lastSeq: 1, lastBatchAt: T0, now: T0 + 3000 });
    expect(r).toEqual({ ok: true, accepted: 3 * MAX_REVS_PER_SEC, capped: true });
  });

  it("does not let idle time be banked beyond the window", () => {
    const r = acceptBatch({ claimedRevs: 10_000, seq: 2, lastSeq: 1, lastBatchAt: T0, now: T0 + 3_600_000 });
    expect(r.ok && r.accepted).toBe((MAX_BATCH_WINDOW_MS / 1000) * MAX_REVS_PER_SEC);
  });

  it("credits a short fixed window to the first batch", () => {
    const r = acceptBatch({ claimedRevs: 10_000, seq: 1, lastSeq: 0, lastBatchAt: 0, now: T0 });
    expect(r.ok && r.accepted).toBe((FIRST_BATCH_WINDOW_MS / 1000) * MAX_REVS_PER_SEC);
  });

  it("rejects replays and garbage", () => {
    expect(acceptBatch({ claimedRevs: 5, seq: 3, lastSeq: 3, lastBatchAt: T0, now: T0 + 1000 })).toEqual({ ok: false, reason: "replay" });
    expect(acceptBatch({ claimedRevs: -1, seq: 4, lastSeq: 3, lastBatchAt: T0, now: T0 + 1000 }).ok).toBe(false);
    expect(acceptBatch({ claimedRevs: "9", seq: 4, lastSeq: 3, lastBatchAt: T0, now: T0 + 1000 }).ok).toBe(false);
    expect(acceptBatch({ claimedRevs: 5, seq: 1.5, lastSeq: 0, lastBatchAt: 0, now: T0 }).ok).toBe(false);
    expect(acceptBatch({ claimedRevs: Infinity, seq: 4, lastSeq: 3, lastBatchAt: T0, now: T0 + 1000 }).ok).toBe(false);
  });

  it("handles a clock going backwards without granting revs", () => {
    const r = acceptBatch({ claimedRevs: 5, seq: 2, lastSeq: 1, lastBatchAt: T0, now: T0 - 5000 });
    expect(r.ok && r.accepted).toBe(0);
  });
});

describe("boost and points", () => {
  it("is x1 at night and grows with rpm, capped", () => {
    expect(boostMilli(false, 50)).toBe(1000);
    expect(boostMilli(true, 0)).toBe(1000);
    expect(boostMilli(true, 40)).toBe(3000);
    expect(boostMilli(true, 10_000)).toBe(7000);
  });
  it("floors points", () => {
    expect(pointsFor(7, 1500)).toBe(10);
  });
});

describe("hamsterDelta", () => {
  it("counts forward movement inside one epoch", () => {
    expect(hamsterDelta({ epoch: "a", work: 100 }, { epoch: "a", work: 130 })).toBe(30);
  });
  it("re-anchors on epoch change, reset, or no anchor", () => {
    expect(hamsterDelta(null, { epoch: "a", work: 130 })).toBe(0);
    expect(hamsterDelta({ epoch: "a", work: 100 }, { epoch: "b", work: 130 })).toBe(0);
    expect(hamsterDelta({ epoch: "a", work: 100 }, { epoch: "a", work: 5 })).toBe(0);
  });
});

describe("stepWake", () => {
  const asleep: WakeMachine = { state: "asleep", since: T0, streak: 0 };

  it("adopts the first reading silently", () => {
    const r = stepWake({ state: "unknown", since: T0, streak: 0 }, true, T0);
    expect(r.event).toBeNull();
    expect(r.next.state).toBe("awake");
  });

  it("needs WAKE_CONFIRM_READINGS running readings to announce waking", () => {
    let m = asleep;
    let event = null as ReturnType<typeof stepWake>["event"];
    for (let i = 1; i <= WAKE_CONFIRM_READINGS; i++) {
      ({ next: m, event } = stepWake(m, true, T0 + i * 60_000));
      if (i < WAKE_CONFIRM_READINGS) expect(event).toBeNull();
    }
    expect(event).toEqual({ kind: "woke" });
    expect(m.state).toBe("awake");
  });

  it("ignores short naps and reports run length when he really sleeps", () => {
    let m: WakeMachine = { state: "awake", since: T0, streak: 0 };
    // 3 quiet minutes, then running again: no event, streak reset
    for (let i = 1; i <= 3; i++) m = stepWake(m, false, T0 + i * 60_000).next;
    m = stepWake(m, true, T0 + 4 * 60_000).next;
    expect(m).toMatchObject({ state: "awake", streak: 0 });
    // now a real sleep
    let event = null as ReturnType<typeof stepWake>["event"];
    for (let i = 1; i <= SLEEP_CONFIRM_READINGS; i++) {
      ({ next: m, event } = stepWake(m, false, T0 + (4 + i) * 60_000));
    }
    expect(event).toEqual({ kind: "slept", ranMs: (4 + SLEEP_CONFIRM_READINGS) * 60_000 });
  });

  it("changes nothing without a signal", () => {
    const r = stepWake(asleep, null, T0 + 60_000);
    expect(r).toEqual({ next: asleep, event: null });
  });
});

describe("referrals", () => {
  it("parses r<id> payloads only", () => {
    expect(parseRef("r123456")).toBe(123456);
    expect(parseRef("123")).toBeNull();
    expect(parseRef("r0")).toBeNull();
    expect(parseRef("r12x")).toBeNull();
    expect(parseRef(undefined)).toBeNull();
  });
  it("gives the inviter 10%, floored", () => {
    expect(refBonus(100)).toBe(10);
    expect(refBonus(9)).toBe(0);
    expect(refBonus(31)).toBe(3);
  });
});

describe("ping runs", () => {
  it("starts on waking, keeps going while awake, stops when he sleeps", () => {
    const r = nextPingRun(null, "awake", true, 1000);
    expect(r).toEqual({ startedAt: 1000, cursor: 0, done: false });
    const cont = { startedAt: 1000, cursor: 55, done: false };
    expect(nextPingRun(cont, "awake", false, 2000)).toBe(cont);
    expect(nextPingRun(cont, "asleep", false, 2000)).toBeNull();
    expect(nextPingRun(null, "awake", false, 2000)).toBeNull();
  });
});
