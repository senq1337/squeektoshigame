import { afterEach, describe, expect, it, vi } from "vitest";
import { _resetSetupThrottle, ensureBotSetup, type Env } from "../src/index";

// Minimal in-memory stand-in for the D1 `kv` table.
function fakeDb() {
  const kv = new Map<string, string>();
  const db = {
    kv,
    prepare(sql: string) {
      let args: unknown[] = [];
      const stmt = {
        bind: (...a: unknown[]) => ((args = a), stmt),
        first: async () => (sql.startsWith("SELECT value FROM kv") && kv.has(args[0] as string) ? { value: kv.get(args[0] as string) } : null),
        run: async () => {
          if (sql.startsWith("INSERT INTO kv")) kv.set(args[0] as string, args[1] as string);
          return { meta: { changes: 1 } };
        },
      };
      return stmt;
    },
  };
  return db;
}

const env = (db: ReturnType<typeof fakeDb>, over: Partial<Env> = {}) =>
  ({ DB: db, BOT_TOKEN: "1:T", WEBHOOK_SECRET: "s3cret", WEBAPP_URL: "", ...over }) as unknown as Env;

afterEach(() => {
  vi.unstubAllGlobals();
  _resetSetupThrottle();
});

describe("ensureBotSetup", () => {
  it("points webhook + menu button at this origin, once", async () => {
    const calls: { method: string; body: any }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ method: url.split("/").pop()!, body: JSON.parse(init.body as string) });
      return new Response(JSON.stringify({ ok: true }));
    });
    const db = fakeDb();
    await ensureBotSetup(env(db), "https://squeektoshi.me.workers.dev");

    const hook = calls.find((c) => c.method === "setWebhook")!;
    expect(hook.body).toMatchObject({ url: "https://squeektoshi.me.workers.dev/tg/webhook", secret_token: "s3cret" });
    const menu = calls.find((c) => c.method === "setChatMenuButton")!;
    expect(menu.body.menu_button.web_app.url).toBe("https://squeektoshi.me.workers.dev");
    expect(calls.map((c) => c.method)).toContain("setMyDescription");
    expect(JSON.parse(db.kv.get("bot_setup")!)).toMatchObject({ origin: "https://squeektoshi.me.workers.dev" });

    // Second call: already set up for this origin -> no Telegram calls.
    _resetSetupThrottle();
    calls.length = 0;
    await ensureBotSetup(env(db), "https://squeektoshi.me.workers.dev");
    expect(calls).toHaveLength(0);
  });

  it("does not record success if Telegram rejects the webhook", async () => {
    vi.stubGlobal("fetch", async (url: string) =>
      new Response(JSON.stringify({ ok: !url.endsWith("setWebhook"), description: "bad" })),
    );
    const db = fakeDb();
    await ensureBotSetup(env(db), "https://squeektoshi.me.workers.dev");
    expect(db.kv.has("bot_setup")).toBe(false);
  });

  it("skips non-https origins and missing secrets", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    await ensureBotSetup(env(fakeDb()), "http://127.0.0.1:8787");
    await ensureBotSetup(env(fakeDb(), { WEBHOOK_SECRET: "" }), "https://x.workers.dev");
    expect(f).not.toHaveBeenCalled();
  });
});
