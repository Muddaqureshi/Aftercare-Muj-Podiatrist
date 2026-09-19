import { addDays, isOpen, validDate } from "../domain.js";
import { HttpError } from "../backend-shared.js";

export const surgeon = { id: 1, username: "Surgeon", role: "clinician" };
export const cookieName = "__Host-aftercare";

export async function hash(value) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map(v => v.toString(16).padStart(2, "0")).join("");
}

export function token() {
  return [...crypto.getRandomValues(new Uint8Array(32))].map(v => v.toString(16).padStart(2, "0")).join("");
}

export async function rateLimit(db, key, limit, seconds, now) {
  const bucket = `${key}:${Math.floor(now.getTime() / (seconds * 1000))}`;
  const result = await db.prepare("INSERT INTO limits(key,count,expires) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count")
    .bind(bucket, now.getTime() + seconds * 2000).first();
  if (result.count > limit) throw new HttpError(429, "Too many attempts. Please wait before trying again.");
}

export async function getState(db) {
  const row = await db.prepare("SELECT * FROM workspace WHERE id=1").first();
  if (!row) throw new HttpError(503, "The database has not been initialized.");
  return { revision: row.revision, patients: JSON.parse(row.patients), closedSince: JSON.parse(row.closed_since) };
}

export function closedCases(patients, previous, today) {
  const closed = {};
  for (const patient of patients) {
    if (patient.milestones.length && patient.milestones.every(m => !isOpen(m))) {
      closed[patient.id] = validDate(previous[patient.id]) ? previous[patient.id] : today;
    }
  }
  return closed;
}

export function retention(state, today) {
  const closedSince = closedCases(state.patients, state.closedSince, today);
  const patients = state.patients.filter(p => !closedSince[p.id] || today < addDays(closedSince[p.id], 30));
  return { patients, closedSince: closedCases(patients, closedSince, today), deleted: state.patients.length - patients.length };
}

export async function saveState(db, revision, patients, closedSince) {
  const json = JSON.stringify(patients);
  if (new TextEncoder().encode(json).length > 900000) throw new HttpError(400, "The fictional workspace is full. Export completed cases before adding more.");
  const result = await db.prepare("UPDATE workspace SET patients=?,closed_since=?,revision=revision+1 WHERE id=1 AND revision=? RETURNING revision")
    .bind(json, JSON.stringify(closedSince), revision).first();
  if (!result) throw new HttpError(409, "Another browser updated the records. Refresh and review before trying again.");
  return { patients, closedSince, revision: result.revision };
}

export async function expireCases(db, today) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const state = await getState(db);
    const next = retention(state, today);
    if (!next.deleted && JSON.stringify(next.closedSince) === JSON.stringify(state.closedSince)) return 0;
    try {
      await saveState(db, state.revision, next.patients, next.closedSince);
      return next.deleted;
    } catch (error) {
      if (!(error instanceof HttpError) || error.status !== 409) throw error;
    }
  }
  throw new HttpError(409, "Retention could not finish because records kept changing. The next scheduled run will try again.");
}

export async function authenticated(request, db, now) {
  const value = (request.headers.get("cookie") || "").split(";").map(p => p.trim()).find(p => p.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
  if (!value || !/^[a-f0-9]{64}$/.test(value)) return null;
  const session = await db.prepare("SELECT token FROM sessions WHERE token=? AND expires>?").bind(await hash(value), now.getTime()).first();
  return session ? surgeon : null;
}
