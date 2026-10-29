// EVM wallet field: validation (EIP-55 checksum) and the top-N export for the Squeekchain team.
import { keccak_256 } from "@noble/hashes/sha3.js";

export type AddressCheck =
  | { ok: true; lower: string; checksummed: string }
  | { ok: false; reason: "format" | "checksum" | "zero" };

const enc = new TextEncoder();

/** EIP-55: uppercase each hex letter whose nibble in keccak256(lowercase hex) is >= 8. */
export function toChecksum(address: string): string {
  const lower = address.toLowerCase().replace(/^0x/, "");
  const hash = keccak_256(enc.encode(lower));
  let out = "0x";
  for (let i = 0; i < 40; i++) {
    const nibble = (hash[i >> 1] >> (i % 2 === 0 ? 4 : 0)) & 0xf;
    out += nibble >= 8 ? lower[i].toUpperCase() : lower[i];
  }
  return out;
}

/**
 * Accepts 0x + 40 hex. All-lowercase / all-uppercase is taken as is; mixed case must be a valid
 * EIP-55 checksum (a mixed-case address with a wrong checksum is almost always a typo).
 */
export function checkAddress(input: unknown): AddressCheck {
  if (typeof input !== "string") return { ok: false, reason: "format" };
  const s = input.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(s)) return { ok: false, reason: "format" };
  const body = s.slice(2);
  const lower = body.toLowerCase();
  if (/^0+$/.test(lower)) return { ok: false, reason: "zero" };
  const checksummed = toChecksum(lower);
  const mixed = body !== lower && body !== body.toUpperCase();
  if (mixed && s !== checksummed) return { ok: false, reason: "checksum" };
  return { ok: true, lower: "0x" + lower, checksummed };
}

export const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

// ---------------------------------------------------------------- export

export interface ExportRow {
  id: number;
  username: string | null;
  first_name: string | null;
  points: number; // in the chosen window (all time / week / today)
  revs: number;
  all_points: number; // all-time total, incl. referral bonus
  ref_points: number; // all-time referral bonus
  wallet: string | null; // lowercase
  wallet_at: number;
  ref_by: number | null;
  invites: number;
  active_invites: number;
  days_played: number;
  created_at: number;
}

export interface ExportCtx {
  adminIds: Set<number>;
  now: number;
}

/**
 * Plain, explainable hints for whoever reviews the list. Nothing is removed automatically.
 *   operator       the bot's own admin (the builder). Shown so nobody can say it was hidden.
 *   no_wallet      can't receive anything
 *   ref_heavy      more than half of all points came from invitees (classic alt-farm shape)
 *   inviter_in_top invited by someone who is also in this list
 *   wallet_recent  wallet set or changed in the last 24 h
 *   one_day        played on a single day only
 */
export function exportFlags(r: ExportRow, inTop: Set<number>, ctx: ExportCtx): string[] {
  const f: string[] = [];
  if (ctx.adminIds.has(r.id)) f.push("operator");
  if (!r.wallet) f.push("no_wallet");
  if (r.all_points > 0 && r.ref_points * 2 > r.all_points) f.push("ref_heavy");
  if (r.ref_by && inTop.has(r.ref_by)) f.push("inviter_in_top");
  if (r.wallet && ctx.now - r.wallet_at < 24 * 3600_000) f.push("wallet_recent");
  if (r.days_played <= 1) f.push("one_day");
  return f;
}

/** A CSV cell: quoted when needed, and never starting with a spreadsheet formula character. */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // names are user-controlled; don't let them run as formulas
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const iso = (ms: number) => (ms > 0 ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") : "");

export function toCsv(rows: ExportRow[], ctx: ExportCtx): string {
  const inTop = new Set(rows.map((r) => r.id));
  const header = [
    "rank", "tg_id", "username", "name", "points", "spins", "wallet", "wallet_set_utc",
    "invited_by", "invites", "invites_spinning", "ref_bonus_pts", "days_played", "first_seen_utc", "flags",
  ];
  const lines = rows.map((r, i) =>
    [
      i + 1,
      r.id,
      r.username ?? "", // bare: a leading "@" would trip the formula guard
      r.first_name ?? "",
      r.points,
      r.revs,
      r.wallet ? toChecksum(r.wallet) : "",
      iso(r.wallet ? r.wallet_at : 0),
      r.ref_by ?? "",
      r.invites,
      r.active_invites,
      r.ref_points,
      r.days_played,
      iso(r.created_at),
      exportFlags(r, inTop, ctx).join(" "),
    ]
      .map(csvCell)
      .join(","),
  );
  return [header.join(","), ...lines].join("\n") + "\n";
}

export type ExportScope = "all" | "week" | "today";
export const parseScope = (s: string | undefined): ExportScope => (s === "week" || s === "today" ? s : "all");
export const EXPORT_DEFAULT_N = 100;
export const EXPORT_MAX_N = 1000;
export const parseN = (s: string | undefined): number => {
  const n = Number(s);
  return Number.isInteger(n) && n > 0 ? Math.min(n, EXPORT_MAX_N) : EXPORT_DEFAULT_N;
};
