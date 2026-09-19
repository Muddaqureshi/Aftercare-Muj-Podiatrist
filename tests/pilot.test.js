import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import http from "node:http";
import { createPilot } from "../pilot/server.js";
import { clinicClock, getState, openStore, setup } from "../pilot/store.js";
import { makeReminders, saveReminderSettings, makeMailer } from "../pilot/reminders.js";
import { resolveInterpretation, makeAI } from "../pilot/ai.js";
import { makeSeed } from "../domain.js";

const fixedNow = new Date("2026-09-19T14:00:00-04:00");
const ai = { async status() { return { ready: false, model: "TEST DOUBLE", message: "Not connected in unit tests." }; }, async ask() { throw new Error("Not called"); } };
const mailer = { mode: "local-inbox", async send() {} };
const password = () => randomBytes(24).toString("hex");

async function fixture(t, dbPath = ":memory:", options = {}) {
  const pilot = createPilot({ dbPath, now: () => fixedNow, ai, mailer, schedule: false, ...options });
  const url = await pilot.listen(0);
  t.after(() => pilot.close());
  const request = async (path, body, cookie, extra = {}) => {
    const response = await fetch(`${url}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { ...(body === undefined ? {} : { "Content-Type": "application/json", Origin: url, "X-Aftercare": "1" }), ...(cookie ? { Cookie: cookie } : {}), ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { status: response.status, data: await response.json(), cookie: response.headers.get("set-cookie")?.split(";")[0], headers: response.headers };
  };
  return { pilot, url, request };
}

test("first-run setup creates an authenticated clinician with a hashed password", async t => {
  const { request, pilot } = await fixture(t);
  assert.equal((await request("/api/state")).status, 401);
  assert.equal((await request("/api/bootstrap")).data.setupRequired, true);
  const secret = password();
  const account = await request("/api/setup", { username: "surgeon", password: secret });
  assert.equal(account.status, 200);
  assert.match(account.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
  const record = pilot.db.prepare("SELECT password FROM users").get();
  assert.notEqual(record.password, secret);
  const state = await request("/api/state", undefined, account.cookie);
  assert.equal(state.data.patients.length, 6);
  assert.equal(state.data.user.role, "clinician");
  assert.equal((await request("/api/setup", { username: "other", password: password() })).status, 409);
  assert.equal((await request("/api/login", { username: "surgeon", password: password() })).status, 401);
  await request("/api/logout", {}, account.cookie);
  assert.equal((await request("/api/state", undefined, account.cookie)).status, 401);
});

test("publication requires sign-in, clinician permission, fictional confirmation, and a current revision", async t => {
  const publications = [];
  const { request } = await fixture(t, ":memory:", { publisher: { async publish(patients, revision) { publications.push({ patients, revision }); return { revision, commitURL: "https://github.com/example/test" }; } } });
  assert.equal((await request("/api/publish", { fictionalOnly: true, revision: 1 })).status, 401);
  const clinician = await request("/api/setup", { username: "surgeon", password: password() });
  const { revision } = (await request("/api/state", undefined, clinician.cookie)).data;
  assert.equal((await request("/api/publish", { revision }, clinician.cookie)).status, 400);
  assert.equal((await request("/api/publish", { revision: revision - 1, fictionalOnly: true }, clinician.cookie)).status, 409);
  const staffPassword = password();
  await request("/api/users", { username: "assistant", password: staffPassword }, clinician.cookie);
  const staff = await request("/api/login", { username: "assistant", password: staffPassword });
  assert.equal((await request("/api/publish", { revision, fictionalOnly: true }, staff.cookie)).status, 403);
  assert.equal(publications.length, 0);
  assert.equal((await request("/api/publish", { revision, fictionalOnly: true }, clinician.cookie)).status, 200);
  assert.equal(publications.length, 1);
  assert.equal(publications[0].patients.length, 6);
});

test("cross-origin writes and private files are blocked", async t => {
  const { request, url } = await fixture(t);
  const rejected = await request("/api/setup", { username: "surgeon", password: password() }, undefined, { Origin: "https://untrusted.example" });
  assert.equal(rejected.status, 403);
  for (const path of ["/.env", "/.data/aftercare.sqlite", "/pilot/server.js", "/package.json"]) {
    assert.equal((await fetch(`${url}${path}`)).status, 404);
  }
  const status = await new Promise((resolve, reject) => {
    const req = http.get(url, { headers: { Host: "untrusted.example" } }, response => { response.resume(); resolve(response.statusCode); });
    req.on("error", reject);
  });
  assert.equal(status, 403);
});

test("staff share records but cannot create plans, change reminders, or add accounts", async t => {
  const { request } = await fixture(t);
  const clinician = await request("/api/setup", { username: "surgeon", password: password() });
  const staffPassword = password();
  assert.equal((await request("/api/users", { username: "assistant", password: staffPassword }, clinician.cookie)).status, 201);
  const staff = await request("/api/login", { username: "assistant", password: staffPassword });
  assert.equal((await request("/api/settings", undefined, staff.cookie)).status, 403);
  assert.equal((await request("/api/users", { username: "another", password: password() }, staff.cookie)).status, 403);
  const state = (await request("/api/state", undefined, staff.cookie)).data;
  const p = state.patients[0], m = p.milestones[1];
  const update = await request("/api/actions", { revision: state.revision, action: "milestone", operation: "complete", patientId: p.id, milestoneId: m.id }, staff.cookie);
  assert.equal(update.status, 200);
  const shared = (await request("/api/state", undefined, clinician.cookie)).data;
  assert.equal(shared.patients[0].milestones[1].status, "completed");
  assert.equal(shared.patients[0].milestones[1].history.at(-1).recordedBy, "assistant");
  assert.equal((await request("/api/actions", { revision: shared.revision, action: "add-case", fields: { code: "DEMO-NEW", surgeryDate: "2026-09-19", procedure: "Other procedure", side: "Not specified", plan: "Day 7: Review" } }, staff.cookie)).status, 403);
  const undo = await request("/api/actions", { revision: shared.revision, action: "milestone", operation: "undo-complete", patientId: p.id, milestoneId: m.id }, staff.cookie);
  assert.equal(undo.data.patients[0].milestones[1].status, "missed");
});

test("stale updates are rejected without overwriting another staff member's change", async t => {
  const { request } = await fixture(t);
  const account = await request("/api/setup", { username: "surgeon", password: password() });
  const state = (await request("/api/state", undefined, account.cookie)).data;
  const p = state.patients[1], m = p.milestones[1];
  const action = { revision: state.revision, action: "milestone", patientId: p.id, milestoneId: m.id };
  assert.equal((await request("/api/actions", { ...action, operation: "contact" }, account.cookie)).status, 200);
  assert.equal((await request("/api/actions", { ...action, operation: "complete" }, account.cookie)).status, 409);
  const fresh = (await request("/api/state", undefined, account.cookie)).data;
  assert.equal(fresh.patients[1].milestones[1].status, "planned");
  assert.equal(fresh.patients[1].milestones[1].history.at(-1).action, "contact");
});

test("server validates outcomes instead of trusting browser data", async t => {
  const { request } = await fixture(t);
  const account = await request("/api/setup", { username: "surgeon", password: password() });
  const state = (await request("/api/state", undefined, account.cookie)).data;
  const p = state.patients[1], m = p.milestones[2];
  const result = await request("/api/actions", { action: "milestone", operation: "miss", revision: state.revision, patientId: p.id, milestoneId: m.id }, account.cookie);
  assert.equal(result.status, 400);
  assert.match(result.data.error, /future/);
  assert.equal((await request("/api/state", undefined, account.cookie)).data.revision, state.revision);
});

test("SQLite records and sessions survive a server restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aftercare-pilot-test-"));
  const file = join(directory, "shared.sqlite");
  let pilot;
  try {
    pilot = createPilot({ dbPath: file, now: () => fixedNow, ai, mailer, schedule: false });
    let url = await pilot.listen(0);
    const response = await fetch(`${url}/api/setup`, { method: "POST", headers: { Origin: url, "X-Aftercare": "1", "Content-Type": "application/json" }, body: JSON.stringify({ username: "surgeon", password: password() }) });
    const cookie = response.headers.get("set-cookie").split(";")[0];
    const ids = getState(pilot.db).patients.map(p => p.id);
    await pilot.close(); pilot = null;
    pilot = createPilot({ dbPath: file, now: () => fixedNow, ai, mailer, schedule: false });
    url = await pilot.listen(0);
    const result = await fetch(`${url}/api/state`, { headers: { Cookie: cookie } });
    assert.equal(result.status, 200);
    assert.deepEqual((await result.json()).patients.map(p => p.id), ids);
  } finally {
    if (pilot) await pilot.close();
    await rm(directory, { recursive: true });
  }
});

test("Massachusetts reminder dates remain correct across daylight saving time", () => {
  assert.deepEqual(clinicClock(new Date("2026-03-08T13:00:00Z")), { today: "2026-03-08", time: "09:00" });
  assert.deepEqual(clinicClock(new Date("2026-11-01T14:00:00Z")), { today: "2026-11-01", time: "09:00" });
  assert.equal(clinicClock(new Date("2026-09-20T02:00:00Z")).today, "2026-09-19");
});

test("daily reminders are durable, deduplicated, generic, and honestly captured locally", async () => {
  const db = openStore(":memory:");
  try {
    setup(db, { username: "surgeon", password: password() }, fixedNow);
    let date = new Date("2026-09-19T08:59:00-04:00");
    const reminders = makeReminders(db, mailer, { now: () => date });
    assert.equal(await reminders.send(), null);
    date = new Date("2026-09-19T09:00:00-04:00");
    const first = await reminders.send();
    assert.equal(first.status, "captured");
    assert.match(first.body, /not emailed/);
    assert.doesNotMatch(first.body, /DEMO-|Wound review|2026-09-15/);
    assert.equal((await reminders.send()).id, first.id);
    assert.equal(db.prepare("SELECT count(*) AS n FROM reminders").get().n, 1);
    date = new Date("2026-09-20T12:00:00-04:00");
    assert.notEqual((await reminders.send()).id, first.id);
  } finally { db.close(); }
});

test("SMTP failures are recorded, not reported as delivery or silently retried", async () => {
  const db = openStore(":memory:");
  try {
    setup(db, { username: "surgeon", password: password() }, fixedNow);
    let attempts = 0;
    const reminders = makeReminders(db, { mode: "smtp", async send() { attempts++; throw new Error("SMTP unavailable"); } }, { now: () => fixedNow });
    const result = await reminders.send();
    assert.equal(result.status, "failed");
    assert.match(result.error, /SMTP unavailable/);
    await reminders.send();
    assert.equal(attempts, 1);
  } finally { db.close(); }
  assert.throws(() => makeMailer({ SMTP_HOST: "smtp.example.test" }), /partially configured/);
});

test("disabled reminders do not run and settings reject invalid addresses and times", async () => {
  const db = openStore(":memory:");
  try {
    setup(db, { username: "surgeon", password: password() }, fixedNow);
    saveReminderSettings(db, { enabled: false, time: "09:00", recipient: "preview@example.test" });
    assert.equal(await makeReminders(db, mailer, { now: () => fixedNow }).send(), null);
    assert.throws(() => saveReminderSettings(db, { enabled: true, time: "25:00", recipient: "preview@example.test" }), /valid reminder/);
    assert.throws(() => saveReminderSettings(db, { enabled: true, time: "09:00", recipient: "test@example.test\nBcc: other@example.test" }), /valid reminder/);
  } finally { db.close(); }
});

test("AI resolves saved-record queries without inventing patient outcomes", () => {
  const state = { revision: 1, patients: makeSeed("2026-09-19") };
  const before = structuredClone(state);
  const answer = resolveInterpretation({ intent: "attention" }, "Who is overdue?", state, "2026-09-19");
  assert.equal(answer.tasks.length, 2);
  assert.equal(answer.tasks[0].milestone.status, "missed");
  assert.deepEqual(state, before);
  const advice = resolveInterpretation({ intent: "unsupported" }, "Recommend antibiotics", state, "2026-09-19");
  assert.equal(advice.kind, "unsupported");
});

test("AI plans require quoted user timing, never choose procedure/side, and remain unsaved", () => {
  const state = { revision: 1, patients: makeSeed("2026-09-19") };
  const prompt = "DEMO-077 had surgery today. Wound review in 7 days, mobility review in 6 weeks.";
  const plan = { intent: "plan", code: "DEMO-077", surgeryDate: "2026-09-19", procedure: "Tendon repair", side: "Right", milestones: [{ day: 7, label: "Wound review", source: "Wound review in 7 days" }, { day: 42, label: "Mobility review", source: "Mobility review in 6 weeks" }] };
  const reply = resolveInterpretation(structuredClone(plan), prompt, state, "2026-09-19");
  assert.equal(reply.kind, "proposal");
  assert.equal(reply.fields.procedure, "Other procedure");
  assert.equal(reply.fields.side, "Not specified");
  assert.equal(reply.sources[1], "mobility review in 6 weeks");
  assert.equal(state.patients.length, 6);
  const fabricated = structuredClone(plan);
  fabricated.milestones[0].day = 14;
  assert.throws(() => resolveInterpretation(fabricated, prompt, state, "2026-09-19"), /exact words/);
  fabricated.milestones[0] = { day: 7, label: "Antibiotic treatment", source: "Wound review in 7 days" };
  assert.throws(() => resolveInterpretation(fabricated, prompt, state, "2026-09-19"), /exact words/);
});

test("AI outage is explicit; no deterministic fallback is called a connected AI", async () => {
  const ai = makeAI({ fetchImpl: async () => { throw new Error("Offline"); } });
  assert.equal((await ai.status()).ready, false);
  await assert.rejects(() => ai.ask("Who needs attention?", { revision: 0, patients: [] }, "2026-09-19"), /connection failed/);
  assert.throws(() => makeAI({ endpoint: "https://remote.example" }), /loopback/);
});
