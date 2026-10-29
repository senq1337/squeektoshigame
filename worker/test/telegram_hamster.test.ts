import { describe, expect, it } from "vitest";
import { normalizeStatus } from "../src/hamster";
import { INIT_DATA_MAX_AGE_S, signInitData, verifyInitData } from "../src/telegram";

const TOKEN = "123456:TEST_TOKEN_not_real";
const NOW_S = 1_800_000_000;

describe("verifyInitData", () => {
  const fields = (authDate = NOW_S) => ({
    auth_date: String(authDate),
    query_id: "AAE",
    user: JSON.stringify({ id: 42, first_name: "Senq", username: "web3senq" }),
  });

  it("accepts correctly signed data", async () => {
    const init = await signInitData(fields(), TOKEN);
    expect(await verifyInitData(init, TOKEN, NOW_S + 10)).toEqual({ id: 42, first_name: "Senq", username: "web3senq" });
  });

  it("rejects a tampered user", async () => {
    const init = await signInitData(fields(), TOKEN);
    const forged = init.replace(encodeURIComponent('"id":42'), encodeURIComponent('"id":43'));
    expect(forged).not.toBe(init);
    expect(await verifyInitData(forged, TOKEN, NOW_S)).toBeNull();
  });

  it("rejects the wrong bot token and stale data", async () => {
    const init = await signInitData(fields(), TOKEN);
    expect(await verifyInitData(init, "999:OTHER", NOW_S)).toBeNull();
    expect(await verifyInitData(init, TOKEN, NOW_S + INIT_DATA_MAX_AGE_S + 1)).toBeNull();
  });

  it("includes the signature field newer clients send in the HMAC check", async () => {
    // Real clients sign signature together with the other fields (only hash is excluded).
    const init = await signInitData({ ...fields(), signature: "c2lnbmF0dXJl" }, TOKEN);
    expect(await verifyInitData(init, TOKEN, NOW_S)).not.toBeNull();
    // Tampering with signature breaks the hash.
    expect(await verifyInitData(init.replace("signature=c2lnbmF0dXJl", "signature=eHh4"), TOKEN, NOW_S)).toBeNull();
  });
});

describe("normalizeStatus", () => {
  // Shape observed on api.squeekchain.com/v1/status, 29.10.2026
  const raw = (over: Record<string, unknown> = {}, observedAgoMs = 1000) => ({
    schemaVersion: 1,
    measurement: {
      freshness: "online",
      observedAt: new Date(NOW_S * 1000 - observedAgoMs).toISOString(),
      staleAfterSeconds: 120,
      counterEpoch: "c011f01a",
      cumulativeWorkUnits: 32660,
      provenance: "hardware",
      coreStatus: "IDLE",
      rpmMilli: 0,
      speedMmPerSecond: 0,
      distanceMm: 0,
      ...over,
    },
    builder: { projected: { blockHeight: 2994 } },
  });

  it("reads an idle wheel", () => {
    const s = normalizeStatus(raw(), NOW_S * 1000);
    expect(s).toMatchObject({ signal: "live", running: false, work: 32660, epoch: "c011f01a", blockHeight: 2994 });
  });

  it("reads a running wheel", () => {
    const s = normalizeStatus(raw({ coreStatus: "ACTIVE", rpmMilli: 42_500, speedMmPerSecond: 300 }), NOW_S * 1000);
    expect(s).toMatchObject({ signal: "live", running: true, rpm: 42.5 });
  });

  it("treats old readings and faults as not running", () => {
    expect(normalizeStatus(raw({ coreStatus: "ACTIVE", rpmMilli: 40_000 }, 10 * 60_000), NOW_S * 1000)).toMatchObject({ signal: "stale", running: false });
    expect(normalizeStatus(raw({ coreStatus: "COUNTER_FAULT", rpmMilli: 40_000 }), NOW_S * 1000)).toMatchObject({ fault: true, running: false });
  });

  it("never throws on junk", () => {
    expect(normalizeStatus(null, NOW_S * 1000)).toMatchObject({ signal: "stale", running: false, work: null });
    expect(normalizeStatus({ measurement: "x" }, NOW_S * 1000).running).toBe(false);
  });
});
