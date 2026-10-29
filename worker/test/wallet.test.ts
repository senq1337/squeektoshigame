import { describe, expect, it } from "vitest";
import { checkAddress, csvCell, exportCaption, exportFlags, parseN, parseScope, toChecksum, toCsv, type ExportRow } from "../src/wallet";

// Test vectors from EIP-55 itself.
const EIP55 = [
  "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
  "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
  "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB",
  "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb",
];

describe("checkAddress", () => {
  it("checksums like EIP-55", () => {
    for (const a of EIP55) expect(toChecksum(a.toLowerCase())).toBe(a);
  });

  it("accepts lowercase, uppercase and correct checksums; trims spaces", () => {
    for (const a of EIP55) {
      expect(checkAddress(a)).toEqual({ ok: true, lower: a.toLowerCase(), checksummed: a });
      expect(checkAddress(a.toLowerCase()).ok).toBe(true);
      expect(checkAddress("0x" + a.slice(2).toUpperCase()).ok).toBe(true);
    }
    expect(checkAddress(`  ${EIP55[0]}\n`).ok).toBe(true);
  });

  it("rejects a mixed-case address with a broken checksum (a typo)", () => {
    const typo = EIP55[0].slice(0, -1) + "D"; // ...BeAeD instead of ...BeAed
    expect(checkAddress(typo)).toEqual({ ok: false, reason: "checksum" });
  });

  it("rejects junk and the zero address", () => {
    expect(checkAddress("0x123")).toEqual({ ok: false, reason: "format" });
    expect(checkAddress("5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed")).toEqual({ ok: false, reason: "format" });
    expect(checkAddress("0xZZaeb6053F3E94C9b9A09f33669435E7Ef1BeAed")).toEqual({ ok: false, reason: "format" });
    expect(checkAddress(42)).toEqual({ ok: false, reason: "format" });
    expect(checkAddress("0x" + "0".repeat(40))).toEqual({ ok: false, reason: "zero" });
  });
});

describe("export", () => {
  const base: ExportRow = {
    id: 1, username: "a", first_name: "A", points: 100, revs: 100, all_points: 100, ref_points: 0,
    wallet: EIP55[0].toLowerCase(), wallet_at: 0, ref_by: null, invites: 0, active_invites: 0, days_played: 3, created_at: 1,
  };
  const ctx = { adminIds: new Set([9]), now: 10 * 86400_000 };

  it("flags what a reviewer should look at, and nothing on a clean row", () => {
    expect(exportFlags(base, new Set([1]), ctx)).toEqual([]);
    const alt: ExportRow = { ...base, id: 2, wallet: null, ref_by: 1, ref_points: 0, days_played: 1 };
    expect(exportFlags(alt, new Set([1, 2]), ctx)).toEqual(["no_wallet", "inviter_in_top", "one_day"]);
    const farmer: ExportRow = { ...base, id: 9, all_points: 100, ref_points: 60, wallet_at: ctx.now - 3600_000 };
    expect(exportFlags(farmer, new Set([9]), ctx)).toEqual(["operator", "ref_heavy", "wallet_recent"]);
  });

  it("writes a CSV with checksummed wallets and safe cells", () => {
    const csv = toCsv([base, { ...base, id: 2, username: null, first_name: '=HYPERLINK("x"),"hi"', wallet: null }], ctx);
    const lines = csv.trim().split("\n");
    expect(lines[0].startsWith("rank,tg_id,username,name,points")).toBe(true);
    expect(lines[1]).toContain(EIP55[0]);
    expect(lines[2]).toContain(`"'=HYPERLINK(""x""),""hi"""`);
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell("-1")).toBe("'-1");
  });

  it("export caption is valid Telegram HTML (no bare < or >)", () => {
    for (const scope of ["all", "week", "today"] as const) {
      const c = exportCaption(scope, 2, 1, Date.UTC(2026, 9, 29, 18, 40));
      const outsideTags = c.replace(/<\/?(b|i|code)>/g, "");
      expect(outsideTags).not.toMatch(/[<>]/);
      expect(c).toContain("&lt;24 h");
    }
  });

  it("parses /export arguments", () => {
    expect(parseScope("week")).toBe("week");
    expect(parseScope("today")).toBe("today");
    expect(parseScope(undefined)).toBe("all");
    expect(parseScope("garbage")).toBe("all");
    expect(parseN("50")).toBe(50);
    expect(parseN("99999")).toBe(1000);
    expect(parseN("-3")).toBe(100);
    expect(parseN(undefined)).toBe(100);
  });
});
