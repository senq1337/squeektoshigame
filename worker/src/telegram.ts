// Telegram helpers: Mini App initData verification + a tiny Bot API client.

export interface TgUser {
  id: number;
  username?: string;
  first_name?: string;
  startParam?: string; // from t.me/<bot>/<app>?startapp=... (referral payload)
}

const enc = new TextEncoder();

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return crypto.subtle.sign("HMAC", k, enc.encode(data));
}

const toHex = (buf: ArrayBuffer) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** Constant-time string compare (both are hex of equal length when valid). */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** initData older than this is rejected (Telegram re-issues it every time the app opens). */
export const INIT_DATA_MAX_AGE_S = 24 * 60 * 60;

/**
 * Verify Telegram.WebApp.initData per https://core.telegram.org/bots/webapps
 *   secret = HMAC_SHA256(key="WebAppData", msg=bot_token)
 *   hash   = hex(HMAC_SHA256(key=secret, msg=data_check_string))
 * data_check_string = all fields except `hash`, as "k=v", sorted by key, joined with "\n".
 * Returns the user, or null if the signature/age is wrong.
 */
export async function verifyInitData(
  initData: string,
  botToken: string,
  nowS: number,
): Promise<TgUser | null> {
  if (!initData || !botToken) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  // Only `hash` is excluded. Newer clients also send `signature` (Ed25519, for third-party
  // validation); for this bot-token HMAC check it stays IN the data-check-string.
  params.delete("hash");
  const dataCheck = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  const secret = await hmac(enc.encode("WebAppData"), botToken);
  const expected = toHex(await hmac(secret, dataCheck));
  if (!safeEqual(expected, hash.toLowerCase())) return null;

  const authDate = Number(params.get("auth_date"));
  if (!Number.isFinite(authDate) || nowS - authDate > INIT_DATA_MAX_AGE_S) return null;

  try {
    const user = JSON.parse(params.get("user") ?? "null");
    if (!user || typeof user.id !== "number") return null;
    return {
      id: user.id,
      username: user.username,
      first_name: user.first_name,
      ...(params.get("start_param") ? { startParam: params.get("start_param")! } : {}),
    };
  } catch {
    return null;
  }
}

/** Test helper: build valid initData for a user (same algorithm, reversed). */
export async function signInitData(
  fields: Record<string, string>,
  botToken: string,
): Promise<string> {
  const dataCheck = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join("\n");
  const secret = await hmac(enc.encode("WebAppData"), botToken);
  const hash = toHex(await hmac(secret, dataCheck));
  const p = new URLSearchParams(fields);
  p.set("hash", hash);
  return p.toString();
}

// ---- Bot API ---------------------------------------------------------------

export type InlineButton =
  | { text: string; web_app: { url: string } }
  | { text: string; url: string }
  | { text: string; callback_data: string };

/**
 * Never throws: a failed send is logged, not raised. Otherwise one Telegram hiccup would make
 * the webhook return 500 and Telegram would keep re-delivering the same update.
 */
export async function tgCall(token: string, method: string, body: unknown): Promise<unknown> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const out = (await res.json()) as { ok?: boolean; description?: string };
    if (!out.ok) console.error(`telegram ${method} failed: ${out.description}`);
    return out;
  } catch (e) {
    console.error(`telegram ${method} error`, e);
    return null;
  }
}

export function sendMessage(
  token: string,
  chatId: string | number,
  text: string,
  buttons?: InlineButton[][],
) {
  return tgCall(token, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}),
  });
}

export function sendPhoto(
  token: string,
  chatId: string | number,
  photoUrl: string,
  caption: string,
  buttons?: InlineButton[][],
) {
  return tgCall(token, "sendPhoto", {
    chat_id: chatId,
    photo: photoUrl,
    caption,
    parse_mode: "HTML",
    ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}),
  });
}

/** Upload an image (e.g. a generated card) straight to a chat, multipart. Never throws. */
export async function sendPhotoBytes(
  token: string,
  chatId: string | number,
  bytes: ArrayBuffer,
  filename: string,
  caption: string,
  buttons?: InlineButton[][],
): Promise<{ ok?: boolean; error_code?: number; description?: string } | null> {
  try {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append("photo", new Blob([bytes], { type: "image/png" }), filename);
    form.append("caption", caption);
    form.append("parse_mode", "HTML");
    if (buttons) form.append("reply_markup", JSON.stringify({ inline_keyboard: buttons }));
    const res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, { method: "POST", body: form });
    return (await res.json()) as { ok?: boolean; error_code?: number; description?: string };
  } catch (e) {
    console.error("telegram sendPhoto (upload) error", e);
    return null;
  }
}

/**
 * The user's current profile photo as bytes (or null if hidden/none).
 * Downloaded server-side because Telegram file URLs contain the bot token.
 */
export async function userPhoto(token: string, userId: number): Promise<ArrayBuffer | null> {
  const photos = (await tgCall(token, "getUserProfilePhotos", { user_id: userId, limit: 1 })) as any;
  const sizes: { file_id: string; width: number }[] | undefined = photos?.result?.photos?.[0];
  if (!sizes?.length) return null;
  // Smallest size that's still >= 320 px wide, else the largest available.
  const pick = [...sizes].sort((a, b) => a.width - b.width).find((s) => s.width >= 320) ?? sizes[sizes.length - 1];
  const file = (await tgCall(token, "getFile", { file_id: pick.file_id })) as any;
  const path: string | undefined = file?.result?.file_path;
  if (!path) return null;
  try {
    const res = await fetch(`https://api.telegram.org/file/bot${token}/${path}`);
    return res.ok ? await res.arrayBuffer() : null;
  } catch {
    return null;
  }
}

/** Escape user-controlled text (names) for parse_mode=HTML. */
export const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
