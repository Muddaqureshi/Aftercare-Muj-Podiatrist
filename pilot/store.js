import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes, scryptSync, timingSafeEqual, createHash } from "node:crypto";
import { createPatient, makeSeed, updateMilestone, validateStore } from "../domain.js";

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function clinicClock(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(now).map(p => [p.type, p.value]));
  return { today: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

export function hashToken(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function passwordHash(password, salt = randomBytes(16).toString("hex")) {
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}

export function passwordMatches(password, stored) {
  const [salt, key] = stored.split(":");
  return timingSafeEqual(scryptSync(password, salt, 64), Buffer.from(key, "hex"));
}

export function credentials(body) {
  const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
  if (!/^[a-z][a-z0-9._-]{2,39}$/.test(username)) throw new HttpError(400, "Use a username with 3–40 letters, numbers, dots, hyphens, or underscores.");
  if (typeof body.password !== "string" || body.password.length < 12 || body.password.length > 128) throw new HttpError(400, "Use a password of 12–128 characters.");
  return { username, password: body.password };
}

export function openStore(path) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  if (path !== ":memory:") chmodSync(path, 0o600);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, password TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('clinician','staff')), created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workspace (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, patients TEXT NOT NULL);
    INSERT OR IGNORE INTO workspace VALUES(1,0,'[]');
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id), action TEXT NOT NULL,
      case_id TEXT, milestone_id TEXT, at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
    INSERT OR IGNORE INTO settings VALUES(1,'{"enabled":true,"time":"09:00","recipient":"preview@example.test"}');
    CREATE TABLE IF NOT EXISTS reminders (
      id TEXT PRIMARY KEY, run_key TEXT NOT NULL UNIQUE, status TEXT NOT NULL,
      recipient TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL,
      created_at TEXT NOT NULL, finished_at TEXT, error TEXT
    );
    UPDATE reminders SET status='uncertain', error='The server stopped during delivery. Check your inbox before sending another reminder.' WHERE status='sending';
  `);
  return db;
}

export function getState(db) {
  const row = db.prepare("SELECT revision, patients FROM workspace WHERE id=1").get();
  return { revision: row.revision, patients: JSON.parse(row.patients) };
}

export function setup(db, body, now) {
  const { username, password } = credentials(body);
  const hash = passwordHash(password);
  db.exec("BEGIN IMMEDIATE");
  try {
    if (db.prepare("SELECT count(*) AS n FROM users").get().n) throw new HttpError(409, "Setup is already complete. Sign in instead.");
    const result = db.prepare("INSERT INTO users(username,password,role,created_at) VALUES(?,?,'clinician',?)").run(username, hash, now.toISOString());
    db.prepare("UPDATE workspace SET patients=?,revision=1 WHERE id=1").run(JSON.stringify(makeSeed(clinicClock(now).today)));
    db.prepare("INSERT INTO audit(user_id,action,at) VALUES(?,'setup',?)").run(Number(result.lastInsertRowid), now.toISOString());
    db.exec("COMMIT");
    return { id: Number(result.lastInsertRowid), username, role: "clinician" };
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

export function requireClinician(user) {
  if (user.role !== "clinician") throw new HttpError(403, "Only the clinician account can manage plans, team members, and reminder settings.");
}

export function mutate(db, user, body, now) {
  if (!Number.isInteger(body.revision)) throw new HttpError(400, "A workspace revision is required.");
  db.exec("BEGIN IMMEDIATE");
  try {
    const state = getState(db);
    if (state.revision !== body.revision) throw new HttpError(409, "Someone updated this workspace. Refresh and review the latest record before trying again.");
    const today = clinicClock(now).today;
    if (body.action === "add-case") {
      requireClinician(user);
      if (!body.fields || typeof body.fields.code !== "string" || typeof body.fields.plan !== "string") throw new HttpError(400, "Enter a patient code and your plan.");
      try { state.patients.push(createPatient(body.fields, state.patients, today)); }
      catch (error) { throw new HttpError(400, error.message); }
    } else if (body.action === "milestone") {
      if (!["complete", "undo-complete", "miss", "contact", "reschedule", "cancel"].includes(body.operation)) throw new HttpError(400, "Choose a supported milestone action.");
      if (body.operation === "cancel") requireClinician(user);
      const patient = state.patients.find(p => p.id === body.patientId);
      if (!patient) throw new HttpError(404, "This case no longer exists.");
      try {
        const milestone = updateMilestone(patient, body.milestoneId, body.operation, today, body.newDate);
        milestone.history.at(-1).recordedBy = user.username;
        milestone.history.at(-1).recordedAt = now.toISOString();
      } catch (error) { throw new HttpError(400, error.message); }
    } else {
      throw new HttpError(400, "This action is not supported.");
    }
    try { validateStore({ version: 1, patients: state.patients }); }
    catch (error) { throw new HttpError(400, error.message); }
    db.prepare("UPDATE workspace SET patients=?,revision=revision+1 WHERE id=1").run(JSON.stringify(state.patients));
    db.prepare("INSERT INTO audit(user_id,action,case_id,milestone_id,at) VALUES(?,?,?,?,?)").run(user.id, body.action === "milestone" ? body.operation : body.action, body.patientId || state.patients.at(-1).id, body.milestoneId || null, now.toISOString());
    db.exec("COMMIT");
    return { patients: state.patients, revision: state.revision + 1, today };
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
