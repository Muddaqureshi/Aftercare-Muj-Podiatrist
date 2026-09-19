import { createPatient, updateMilestone, validateStore } from "./domain.js";

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

export function requireClinician(user) {
  if (user.role !== "clinician") throw new HttpError(403, "Only the clinician account can manage plans, team members, and reminder settings.");
}

export function mutatePatients(current, user, body, now) {
  const patients = structuredClone(current);
  const today = clinicClock(now).today;
  if (body.action === "add-case") {
    requireClinician(user);
    if (!body.fields || typeof body.fields.code !== "string" || typeof body.fields.plan !== "string") throw new HttpError(400, "Enter a patient code and your plan.");
    try { patients.push(createPatient(body.fields, patients, today)); }
    catch (error) { throw new HttpError(400, error.message); }
  } else if (body.action === "milestone") {
    if (!["complete", "undo-complete", "miss", "contact", "reschedule", "cancel"].includes(body.operation)) throw new HttpError(400, "Choose a supported milestone action.");
    if (body.operation === "cancel") requireClinician(user);
    const patient = patients.find(p => p.id === body.patientId);
    if (!patient) throw new HttpError(404, "This case no longer exists.");
    try {
      const milestone = updateMilestone(patient, body.milestoneId, body.operation, today, body.newDate);
      milestone.history.at(-1).recordedBy = user.username;
      milestone.history.at(-1).recordedAt = now.toISOString();
    } catch (error) { throw new HttpError(400, error.message); }
  } else {
    throw new HttpError(400, "This action is not supported.");
  }
  try { validateStore({ version: 1, patients }); }
  catch (error) { throw new HttpError(400, error.message); }
  return patients;
}
