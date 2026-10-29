// End-to-end check against a local `wrangler dev` + mock status server.
//   node test/integration.mjs http://127.0.0.1:8787 http://127.0.0.1:8799
// Needs an empty local D1 (re-apply schema.sql or DELETE FROM the four tables first).
import { createHmac } from "node:crypto";
import { execSync } from "node:child_process";
import assert from "node:assert/strict";

const API = process.argv[2] ?? "http://127.0.0.1:8787";
const MOCK = process.argv[3] ?? "http://127.0.0.1:8799";
const TOKEN = "123456:TEST_TOKEN_not_real"; // same as .dev.vars
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function initData(user, extra = {}) {
  const fields = { auth_date: String(Math.floor(Date.now() / 1000)), query_id: "AAE", user: JSON.stringify(user), ...extra };
  const dcs = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(TOKEN).digest();
  const hash = createHmac("sha256", secret).update(dcs).digest("hex");
  return new URLSearchParams({ ...fields, hash }).toString();
}

async function spin(body, { init, devUser } = {}) {
  const url = `${API}/api/spin${devUser ? `?dev_user=${devUser}` : ""}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(init ? { "x-init-data": init } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}
const get = async (p) => (await fetch(API + p)).json();
const cron = () => fetch(`${API}/__scheduled?cron=*+*+*+*+*`);
const step = (name) => console.log("✓", name);

await fetch(`${MOCK}/set?running=0&rpm=0`);
await sleep(10500); // let the worker's 10 s hamster cache expire

// 1. Night shift, dev user: first batch is capped at 5 s x 6 rev/s
let r = await spin({ revs: 100, seq: 1 }, { devUser: 7 });
assert.equal(r.status, 200);
assert.equal(r.body.accepted, 30);
assert.equal(r.body.capped, true);
assert.equal(r.body.boost, 1);
step("first batch capped at 30 revs, boost x1 at night");

// 2. Immediate second batch: no time passed -> 0 accepted
r = await spin({ revs: 10, seq: 2 }, { devUser: 7 });
assert.equal(r.body.accepted, 0);
step("burst right after a batch gets 0");

// 3. Replay
r = await spin({ revs: 10, seq: 2 }, { devUser: 7 });
assert.equal(r.status, 409);
step("replayed seq rejected (409)");

// 4. Signed Telegram user
const user = { id: 42, first_name: "Senq", username: "web3senq" };
r = await spin({ revs: 20, seq: 1 }, { init: initData(user) });
assert.equal(r.status, 200);
assert.equal(r.body.accepted, 20);
assert.equal(r.body.me.today_points, 20);
step("signed initData accepted");

// 5. Forged signature
const forged = initData(user).replace(/hash=[0-9a-f]+/, "hash=" + "0".repeat(64));
r = await spin({ revs: 20, seq: 2 }, { init: forged });
assert.equal(r.status, 401);
step("forged initData rejected (401)");

// 6. Hamster wakes up at 40 rpm -> boost x3
await fetch(`${MOCK}/set?running=1&rpm=40`);
await sleep(10500);
r = await spin({ revs: 15, seq: 2 }, { init: initData(user) });
assert.equal(r.body.hamster.running, true);
assert.equal(r.body.boost, 3);
assert.equal(r.body.accepted, 15);
assert.equal(r.body.me.today_points, 20 + 45);
step("running hamster boosts spins (15 revs x3 = 45 pts)");

// 7. Cron: anchor + count hamster work + wake/sleep machine
for (let i = 0; i < 3; i++) { await cron(); await sleep(10500); }
let s = await get("/api/state");
assert.ok(s.today.hamsterWork > 0, "hamster work counted");
step(`cron counted hamster work (${s.today.hamsterWork} units)`);
await fetch(`${MOCK}/set?running=0&rpm=0`);
await sleep(10500);
for (let i = 0; i < 11; i++) await cron(); // >= SLEEP_CONFIRM_READINGS quiet readings -> "slept" alert attempt
step("sleep detection ran (alert send attempted; no Telegram egress here)");

// 8. Leaderboards
const today = await get("/api/leaderboard?scope=today");
assert.equal(today.top[0].name, "@web3senq");
assert.equal(today.top[0].points, 65);
const all = await get("/api/leaderboard?scope=all");
assert.equal(all.top.length, 2);
s = await get("/api/state");
assert.equal(s.today.humanRevs, 30 + 20 + 15);
step(`leaderboards ok; humans today: ${s.today.humanRevs} revs = ${s.today.humanWork} work`);

// 8b. My own rank comes back with the leaderboard
const mineToday = await (await fetch(`${API}/api/leaderboard?scope=today&dev_user=7`)).json();
assert.deepEqual(mineToday.me, { rank: 2, points: 30, revs: 30 });
const nobody = await (await fetch(`${API}/api/leaderboard?scope=today&dev_user=999`)).json();
assert.equal(nobody.me, null);
step("my rank: dev user 7 is #2 today; a player with no spins gets null");

// 9. Webhook auth
let w = await fetch(`${API}/tg/webhook`, { method: "POST", body: "{}" });
assert.equal(w.status, 403);
w = await fetch(`${API}/tg/webhook`, {
  method: "POST",
  headers: { "x-telegram-bot-api-secret-token": "testsecret", "content-type": "application/json" },
  body: JSON.stringify({ message: { text: "/top", chat: { id: 1, type: "private" } } }),
});
assert.equal(w.status, 200);
step("webhook: wrong secret 403, /top handled 200");

// 11. Referrals (also exercises the automatic v2 schema migration)
const hook = (message) => fetch(`${API}/tg/webhook`, {
  method: "POST",
  headers: { "x-telegram-bot-api-secret-token": "testsecret", "content-type": "application/json" },
  body: JSON.stringify({ message }),
});
assert.equal((await hook({ text: "/start r7", chat: { id: 501, type: "private" }, from: { id: 501, username: "friend1" } })).status, 200);
r = await spin({ revs: 20, seq: 1 }, { devUser: 501 });
assert.equal(r.status, 200);
const friendPts = r.body.me.today_points;
const me7 = await (await fetch(`${API}/api/me?dev_user=7`)).json();
assert.equal(me7.invites.friends, 1);
assert.equal(me7.invites.active, 1);
assert.equal(me7.invites.bonusPoints, Math.floor(friendPts / 10));
assert.equal(me7.today.points, 30 + Math.floor(friendPts / 10));
step(`/start r7 -> friend spun ${friendPts} pts, inviter got +${me7.invites.bonusPoints} (10%)`);

// self-invite and re-inviting someone who already spun are ignored
await hook({ text: "/start r502", chat: { id: 502, type: "private" }, from: { id: 502 } });
await hook({ text: "/start r42", chat: { id: 501, type: "private" }, from: { id: 501 } });
const me502 = await (await fetch(`${API}/api/me?dev_user=502`)).json();
assert.equal(me502.invites.friends, 0);
let me42 = await (await fetch(`${API}/api/me`, { headers: { "x-init-data": initData(user) } })).json();
assert.equal(me42.invites.friends, 0);
step("self-invite ignored; a friend who already spun can't be re-invited");

// Mini App deep link: startapp=r42 arrives as start_param in signed initData
const newbie = { id: 777, first_name: "New" };
r = await spin({ revs: 10, seq: 1 }, { init: initData(newbie, { start_param: "r42" }) });
assert.equal(r.status, 200);
me42 = await (await fetch(`${API}/api/me`, { headers: { "x-init-data": initData(user) } })).json();
assert.equal(me42.invites.friends, 1);
step("startapp=r42 in initData registers the referral on first spin");

// 12. Wake-up pings: opt in, then the hamster wakes -> a ping run starts and finishes
let n = await (await fetch(`${API}/api/notify?dev_user=7`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ on: true }) })).json();
assert.equal(n.notify, true);
// No Telegram here, so the confirmation fails and chat_ok drops to 0; pressing /start restores it.
let me7b = await (await fetch(`${API}/api/me?dev_user=7`)).json();
assert.deepEqual(me7b.alerts, { on: true, chatOk: false });
await hook({ text: "/start", chat: { id: 7, type: "private" }, from: { id: 7, username: "dev7" } });
me7b = await (await fetch(`${API}/api/me?dev_user=7`)).json();
assert.deepEqual(me7b.alerts, { on: true, chatOk: true });
await fetch(`${MOCK}/set?running=1&rpm=40`);
for (let i = 0; i < 3; i++) { await sleep(10500); await cron(); }
const kvRun = execSync(`npx wrangler d1 execute squeektoshi -c wrangler.local.jsonc --local --json --command "SELECT value FROM kv WHERE key='ping_run'"`, { encoding: "utf8" });
const runVal = JSON.parse(JSON.parse(kvRun)[0].results[0].value);
assert.equal(runVal.done, true);
assert.ok(runVal.cursor >= 7, "player 7 was in the batch");
step(`opt-in works; hamster woke -> ping run went through (cursor ${runVal.cursor}, done)`);
await fetch(`${MOCK}/set?running=0&rpm=0`);

// 13. Card upload + avatar proxy (no Telegram egress here, so sending fails cleanly)
const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001", "hex");
let cr = await fetch(`${API}/api/card?dev_user=7`, { method: "POST", headers: { "content-type": "image/png" }, body: png });
assert.equal(cr.status, 502);
cr = await fetch(`${API}/api/card?dev_user=7`, { method: "POST", headers: { "content-type": "image/png" }, body: png });
assert.equal(cr.status, 429);
cr = await fetch(`${API}/api/card?dev_user=8`, { method: "POST", headers: { "content-type": "image/png" }, body: Buffer.from("not a png") });
assert.equal(cr.status, 400);
const av = await fetch(`${API}/api/avatar?dev_user=7`);
assert.equal(av.status, 404);
step("card: PNG accepted (send fails offline), 30 s cooldown, non-PNG rejected; avatar 404 without Telegram");

// 10. Recap job runs without crashing (no row for yesterday -> no-op)
const rc = await fetch(`${API}/dev/recap`);
assert.equal(rc.status, 200);
step("recap job ok");

console.log("\nALL GOOD");
