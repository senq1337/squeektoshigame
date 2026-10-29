// End-to-end check against a local `wrangler dev` + mock status server.
//   node test/integration.mjs http://127.0.0.1:8787 http://127.0.0.1:8799
// Needs an empty local D1 (re-apply schema.sql or DELETE FROM the four tables first).
import { createHmac } from "node:crypto";
import assert from "node:assert/strict";

const API = process.argv[2] ?? "http://127.0.0.1:8787";
const MOCK = process.argv[3] ?? "http://127.0.0.1:8799";
const TOKEN = "123456:TEST_TOKEN_not_real"; // same as .dev.vars
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function initData(user) {
  const fields = { auth_date: String(Math.floor(Date.now() / 1000)), query_id: "AAE", user: JSON.stringify(user) };
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

// 10. Recap job runs without crashing (no row for yesterday -> no-op)
const rc = await fetch(`${API}/dev/recap`);
assert.equal(rc.status, 200);
step("recap job ok");

console.log("\nALL GOOD");
