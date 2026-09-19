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
  const env = { DB: db, GMAIL_ADDRESS: address, APP_ORIGIN: origin, ASSETS: { async fetch() { return new Response("public application shell"); } }, AI_MODEL: "TEST DOUBLE" };
  const worker = createWorker({ now: () => time, mailerFactory: () => mailer, aiFactory: () => ({ async status() { return { ready: false, model: "TEST DOUBLE" }; } }) });
  const request = async (path, body, cookie, extra = {}) => {
    const response = await worker.fetch(new Request(`${origin}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { ...(body === undefined ? {} : { Origin: origin, "Content-Type": "application/json", "X-Aftercare": "1" }), ...(cookie ? { Cookie: cookie } : {}), ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    }), env);
    return { status: response.status, data: await response.json(), cookie: response.headers.get("set-cookie")?.split(";")[0], headers: response.headers };
  };
  async function signin() {
    const sent = await request("/api/login", { email: address });
    assert.equal(sent.status, 200);
    const code = messages.at(-1).body.match(/\b\d{8}\b/)[0];
    return request("/api/login", { email: address, code });
  }
  return { db, env, worker, request, messages, mailer, signin, date: () => time, setDate(value) { time = new Date(value); } };
}

test("hosted login is owner-only, single-use, and creates a secure hashed session", async t => {
  const { request, signin, messages, db } = fixture(t);
  assert.equal((await request("/api/state")).status, 401);
  assert.equal((await request("/api/login", { email: "not-owner@example.test" })).status, 401);
  assert.equal(messages.length, 0);
  const signedIn = await signin();
  assert.equal(signedIn.status, 200);
  assert.match(signedIn.headers.get("set-cookie"), /Secure; HttpOnly; SameSite=Strict/);
  assert.match(signedIn.cookie, /^__Host-aftercare=/);
  const stored = await db.prepare("SELECT token FROM sessions").first();
  assert.notEqual(stored.token, signedIn.cookie.split("=")[1]);
  const code = messages.at(-1).body.match(/\b\d{8}\b/)[0];
  assert.equal((await request("/api/login", { email: address, code })).status, 401);
  assert.equal((await request("/api/state", undefined, signedIn.cookie)).data.patients.length, 0);
  await request("/api/logout", {}, signedIn.cookie);
  assert.equal((await request("/api/state", undefined, signedIn.cookie)).status, 401);
});

test("codes expire, incorrect guesses are bounded, and login sends are throttled", async t => {
  const f = fixture(t);
  await f.request("/api/login", { email: address });
  const code = f.messages.at(-1).body.match(/\b\d{8}\b/)[0];
  assert.equal((await f.request("/api/login", { email: address })).status, 429);
  const wrong = code === "11111111" ? "22222222" : "11111111";
  for (let i = 0; i < 8; i++) assert.equal((await f.request("/api/login", { email: address, code: wrong })).status, 401);
  assert.equal((await f.request("/api/login", { email: address, code })).status, 401);
  f.setDate("2026-09-19T14:02:00-04:00");
  await f.request("/api/login", { email: address });
  const fresh = f.messages.at(-1).body.match(/\b\d{8}\b/)[0];
  f.setDate("2026-09-19T14:13:00-04:00");
  assert.equal((await f.request("/api/login", { email: address, code: fresh })).status, 401);
});

test("cross-origin writes, secrets, public registration, and publication are blocked", async t => {
  const f = fixture(t);
  assert.equal((await f.request("/api/login", { email: address }, undefined, { Origin: "https://other.example" })).status, 403);
  for (const path of ["/.env", "/cloud/worker.js", "/.data/aftercare.sqlite", "/__test-code"]) {
    assert.equal((await f.worker.fetch(new Request(`${origin}${path}`), f.env)).status, 404);
  }
  const account = await f.signin();
  assert.equal((await f.request("/api/setup", {}, account.cookie)).status, 404);
  assert.equal((await f.request("/api/publish", {}, account.cookie)).status, 404);
  assert.equal((await f.worker.fetch(new Request("https://other.example/api/bootstrap"), f.env)).status, 503);
});

test("online mutations are shared and stale updates cannot overwrite another browser", async t => {
  const f = fixture(t), account = await f.signin();
  const seeded = await f.request("/api/actions", { revision: 0, action: "load-demo", fictionalOnly: true }, account.cookie);
  assert.equal(seeded.data.patients.length, 6);
  const p = seeded.data.patients[0], m = p.milestones[1];
  const action = { revision: seeded.data.revision, action: "milestone", patientId: p.id, milestoneId: m.id, operation: "complete" };
  assert.equal((await f.request("/api/actions", action, account.cookie)).status, 200);
  assert.equal((await f.request("/api/actions", { ...action, operation: "contact" }, account.cookie)).status, 409);
  const fresh = (await f.request("/api/state", undefined, account.cookie)).data;
  assert.equal(fresh.patients[0].milestones[1].status, "completed");
  assert.equal(fresh.patients[0].milestones[1].history.at(-1).recordedBy, "Surgeon");
  assert.equal((await f.request("/api/actions", { action: "load-demo", revision: fresh.revision, fictionalOnly: true }, account.cookie)).status, 400);
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
  const f = fixture(t), account = await f.signin();
  await f.request("/api/actions", { revision: 0, action: "load-demo", fictionalOnly: true }, account.cookie);
  assert.equal((await f.request("/api/settings", { enabled: true, time: "09:00", recipient: "other@example.test" }, account.cookie)).status, 400);
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
