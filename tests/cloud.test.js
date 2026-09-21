import test from "node:test";
import assert from "node:assert/strict";
import { createWorker } from "../cloud/worker.js";
import { closedCases, retention, getState, saveState, expireCases } from "../cloud/core.js";
import { hostedAI, sendReminder } from "../cloud/services.js";
import { makeSeed, addDays } from "../domain.js";
import { testDatabase } from "./d1-fixture.js";

const address = "fictional-owner@example.test";
const origin = "https://aftercare.example.test";

function fixture(t) {
  const db = testDatabase();
  t.after(() => db.close());
  let time = new Date("2026-09-19T14:00:00-04:00");
  const messages = [];
  const mailer = { async send(message) { messages.push(message); } };
  const env = { DB: db, GMAIL_ADDRESS: address, GMAIL_APP_PASSWORD: "private-test-secret", APP_ORIGIN: origin, ASSETS: { async fetch() { return new Response("public application shell"); } }, AI_MODEL: "TEST DOUBLE" };
  const worker = createWorker({ now: () => time, mailerFactory: () => mailer, aiFactory: () => ({
    async status() { return { ready: false, model: "TEST DOUBLE" }; },
    async ask() { return { kind: "unsupported", message: "TEST DOUBLE" }; }
  }) });
  const request = async (path, body, extra = {}) => {
    const response = await worker.fetch(new Request(`${origin}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { ...(body === undefined ? {} : { Origin: origin, "Content-Type": "application/json", "X-Aftercare": "1" }), ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    }), env);
    return { status: response.status, data: await response.json(), headers: response.headers };
  };
  return { db, env, worker, request, messages, mailer, date: () => time, setDate(value) { time = new Date(value); } };
}

test("public workspace opens without credentials and clears obsolete login cookies", async t => {
  const f = fixture(t);
  const bootstrap = await f.request("/api/bootstrap");
  assert.equal(bootstrap.status, 200);
  assert.equal(bootstrap.data.accessMode, "public");
  assert.equal(bootstrap.data.setupRequired, false);
  assert.equal(bootstrap.data.passwordSalt, undefined);
  assert.match(bootstrap.headers.get("set-cookie"), /Max-Age=0/);
  assert.equal((await f.request("/api/state")).status, 200);
  assert.equal((await f.request("/api/state")).data.patients.length, 0);
  assert.equal(f.messages.length, 0);
  assert.equal((await f.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name IN ('sessions','login_challenge')").first()).n, 0);
});

test("anonymous writes are throttled without blocking public reads", async t => {
  const f = fixture(t);
  for (let i = 0; i < 30; i++) assert.equal((await f.request("/api/actions", {})).status, 409);
  assert.equal((await f.request("/api/actions", {})).status, 429);
  assert.equal((await f.request("/api/state")).status, 200);
  assert.equal(f.messages.length, 0);
  f.setDate("2026-09-19T14:02:00-04:00");
  assert.equal((await f.request("/api/actions", { revision: 0, action: "load-demo", fictionalOnly: true })).status, 200);
});

test("public visitors cannot reveal Gmail details, change settings, or send email", async t => {
  const f = fixture(t);
  await sendReminder(f.env, f.mailer, f.date(), true);
  const before = f.messages.length;
  for (const path of ["/api/bootstrap", "/api/state", "/api/settings", "/api/ai/status"]) {
    const result = await f.request(path);
    assert.equal(result.status, 200);
    const text = JSON.stringify(result.data);
    assert.ok(!text.includes(address));
    assert.ok(!text.includes(f.env.GMAIL_APP_PASSWORD));
    assert.ok(!text.includes("recipient"));
    assert.equal(result.data.reminders, undefined);
  }
  for (const path of ["/api/login", "/api/logout", "/api/setup", "/api/users", "/api/publish", "/api/settings", "/api/reminders/test"]) {
    assert.equal((await f.request(path, { enabled: false, time: "00:00", recipient: "other@example.test" })).status, 404);
  }
  assert.equal(f.messages.length, before);
  assert.equal((await f.db.prepare("SELECT enabled FROM settings WHERE id=1").first()).enabled, 1);
});

test("global public write limits enforce the exact minute and daily caps", async t => {
  for (const [key, limit, seconds] of [["public-writes-total", 120, 60], ["public-writes-day", 500, 86400]]) {
    const f = fixture(t);
    const bucket = `${key}:${Math.floor(f.date().getTime() / (seconds * 1000))}`;
    await f.db.prepare("INSERT INTO limits(key,count,expires) VALUES(?,?,?)").bind(bucket, limit - 1, f.date().getTime() + seconds * 2000).run();
    assert.equal((await f.request("/api/actions", {})).status, 409);
    assert.equal((await f.request("/api/actions", {}, { "CF-Connecting-IP": "192.0.2.2" })).status, 429);
    assert.equal((await f.request("/api/state")).status, 200);
  }
});

test("public AI limits enforce ten requests per IP and twenty per hour globally", async t => {
  const f = fixture(t);
  for (const ip of ["192.0.2.1", "192.0.2.2"]) {
    for (let n = 0; n < 10; n++) assert.equal((await f.request("/api/assistant", { prompt: "Hello" }, { "CF-Connecting-IP": ip })).status, 200);
    assert.equal((await f.request("/api/assistant", { prompt: "Hello" }, { "CF-Connecting-IP": ip })).status, 429);
  }
  assert.equal((await f.request("/api/assistant", { prompt: "Hello" }, { "CF-Connecting-IP": "192.0.2.3" })).status, 429);
  f.setDate("2026-09-19T15:00:00-04:00");
  assert.equal((await f.request("/api/assistant", { prompt: "Hello" })).status, 200);
});

test("public AI enforces its fifty-request daily cap independently of hourly limits", async t => {
  const f = fixture(t);
  const bucket = `owner-ai-day:${Math.floor(f.date().getTime() / 86400000)}`;
  await f.db.prepare("INSERT INTO limits(key,count,expires) VALUES(?,?,?)").bind(bucket, 49, f.date().getTime() + 172800000).run();
  assert.equal((await f.request("/api/assistant", { prompt: "Hello" })).status, 200);
  assert.equal((await f.request("/api/assistant", { prompt: "Hello" })).status, 429);
  assert.equal((await f.request("/api/actions", { revision: 0, action: "load-demo", fictionalOnly: true })).status, 200);
});

test("cross-origin writes, secrets, public registration, and publication are blocked", async t => {
  const f = fixture(t);
  assert.equal((await f.request("/api/actions", {}, { Origin: "https://other.example" })).status, 403);
  for (const path of ["/.env", "/cloud/worker.js", "/.data/aftercare.sqlite", "/__test-code", "/__scheduled", "/password-auth.js"]) {
    assert.equal((await f.worker.fetch(new Request(`${origin}${path}`), f.env)).status, 404);
  }
  assert.equal((await f.request("/api/setup", {})).status, 404);
  assert.equal((await f.request("/api/publish", {})).status, 404);
  assert.equal((await f.worker.fetch(new Request("https://other.example/api/bootstrap"), f.env)).status, 503);
});

test("online mutations are shared and stale updates cannot overwrite another browser", async t => {
  const f = fixture(t);
  const seeded = await f.request("/api/actions", { revision: 0, action: "load-demo", fictionalOnly: true });
  assert.equal(seeded.data.patients.length, 6);
  const p = seeded.data.patients[0], m = p.milestones[1];
  const action = { revision: seeded.data.revision, action: "milestone", patientId: p.id, milestoneId: m.id, operation: "complete" };
  assert.equal((await f.request("/api/actions", action)).status, 200);
  assert.equal((await f.request("/api/actions", { ...action, operation: "contact" })).status, 409);
  const fresh = (await f.request("/api/state")).data;
  assert.equal(fresh.patients[0].milestones[1].status, "completed");
  assert.equal(fresh.patients[0].milestones[1].history.at(-1).recordedBy, "Public demo visitor");
  assert.equal((await f.request("/api/actions", { action: "load-demo", revision: fresh.revision, fictionalOnly: true })).status, 400);
});

test("retention starts on closure, keeps future open work, and resets after reopening", () => {
  const p = makeSeed("2026-09-19")[0];
  let state = { patients: [p], closedSince: {} };
  assert.equal(retention(state, "2027-09-19").patients.length, 1);
  for (const m of p.milestones) m.status = "completed";
  state.closedSince = closedCases(state.patients, {}, "2026-09-19");
  assert.equal(retention(state, "2026-10-18").patients.length, 1);
  assert.equal(retention(state, "2026-10-19").patients.length, 0);
  p.milestones[0].status = "missed";
  state.closedSince = closedCases(state.patients, state.closedSince, "2026-10-01");
  assert.deepEqual(state.closedSince, {});
  p.milestones[0].status = "cancelled";
  state.closedSince = closedCases(state.patients, state.closedSince, "2026-10-02");
  assert.equal(retention(state, "2026-10-31").patients.length, 1);
  assert.equal(retention(state, "2026-11-01").patients.length, 0);
});

test("scheduled retention deletes only closed records and invalidates stale browser revisions", async t => {
  const f = fixture(t);
  const patients = makeSeed("2026-09-19");
  const closed = closedCases(patients, {}, "2026-09-19");
  await saveState(f.db, 0, patients, closed);
  assert.equal(await expireCases(f.db, "2026-10-18"), 0);
  assert.equal(await expireCases(f.db, "2026-10-19"), 1);
  const state = await getState(f.db);
  assert.equal(state.patients.length, 5);
  assert.ok(state.patients.some(p => p.milestones.some(m => m.date === addDays("2026-09-19", 31))));
  await assert.rejects(() => saveState(f.db, 1, patients, closed), /Another browser/);
});

test("hosted reminders are deduplicated, generic, and cannot be redirected to other recipients", async t => {
  const f = fixture(t);
  await f.request("/api/actions", { revision: 0, action: "load-demo", fictionalOnly: true });
  assert.equal((await f.request("/api/settings", { enabled: true, time: "09:00", recipient: "other@example.test" })).status, 404);
  const before = f.messages.length;
  const first = await sendReminder(f.env, f.mailer, f.date());
  const second = await sendReminder(f.env, f.mailer, f.date());
  assert.equal(first.id, second.id);
  assert.equal(first.status, "accepted");
  assert.equal(f.messages.length, before + 1);
  assert.doesNotMatch(first.body, /DEMO-|Wound|surgery/);
  assert.equal(first.recipient, address);
});

test("email failures are explicit and not automatically retried", async t => {
  const f = fixture(t);
  await saveState(f.db, 0, makeSeed("2026-09-19"), {});
  let attempts = 0;
  const failed = { async send() { attempts++; throw Error("simulated failure"); } };
  assert.equal((await sendReminder(f.env, failed, f.date())).status, "uncertain");
  assert.equal((await sendReminder(f.env, failed, f.date())).status, "uncertain");
  assert.equal(attempts, 1);
});

test("the scheduled entry point performs cleanup and sends a due reminder", async t => {
  const f = fixture(t);
  await saveState(f.db, 0, makeSeed("2026-09-19"), {});
  await f.worker.scheduled({}, f.env);
  await f.worker.scheduled({}, f.env);
  assert.equal(f.messages.length, 1);
  assert.equal((await f.db.prepare("SELECT status FROM reminders").first()).status, "accepted");
});

test("hosted AI uses structured interpretation and surfaces free-quota failures", async () => {
  const calls = [];
  const ai = hostedAI({ AI_MODEL: "TEST DOUBLE", AI: { async run(model, input) { calls.push({ model, input }); return { response: { intent: "attention", offset: 0, code: "" } }; } } });
  const state = { revision: 1, patients: makeSeed("2026-09-19") };
  const reply = await ai.ask("Who needs attention?", state, "2026-09-19");
  assert.equal(reply.tasks.length, 2);
  assert.equal(calls[0].input.response_format.type, "json_schema");
  assert.ok(!JSON.stringify(calls[0]).includes(state.patients[0].id));
  const offline = hostedAI({ AI_MODEL: "TEST DOUBLE", AI: { async run() { throw Error("quota"); } } });
  await assert.rejects(() => offline.ask("Who needs attention?", state, "2026-09-19"), /free allowance/);
});
