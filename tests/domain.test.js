import test from "node:test";
import assert from "node:assert/strict";
import {
  localToday, validDate, addDays, daysBetween, weekBounds, milestoneState,
  attentionTasks, weeklyTasks, createPatient, parsePlan, updateMilestone,
  parseAssistant, makeSeed, validateStore, makeCalendar, isOpen
} from "../domain.js";

const today = "2026-09-19";
const fields = { code: "DEMO-042", surgeryDate: today, procedure: "Forefoot surgery", side: "Left", plan: "Day 7: First review\nWeek 3: Review recovery" };
const patient = () => createPatient(fields, [], today);

test("calendar arithmetic preserves dates across DST, leap days, and years", () => {
  assert.equal(addDays("2026-03-07", 2), "2026-03-09");
  assert.equal(addDays("2026-10-31", 2), "2026-11-02");
  assert.equal(addDays("2028-02-28", 1), "2028-02-29");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(daysBetween("2026-03-07", "2026-03-09"), 2);
  assert.equal(localToday(new Date(2026, 8, 19, 23, 59)), today);
  assert.equal(validDate("2026-02-29"), false);
  assert.equal(validDate("2026-13-01"), false);
  assert.equal(validDate("2026-09-19<script>"), false);
  assert.throws(() => addDays("bad", 2));
});

test("weeks are Monday–Sunday, including Sunday and offsets", () => {
  assert.deepEqual(weekBounds(today), { start: "2026-09-14", end: "2026-09-20" });
  assert.deepEqual(weekBounds("2026-09-20"), { start: "2026-09-14", end: "2026-09-20" });
  assert.deepEqual(weekBounds(today, 1), { start: "2026-09-21", end: "2026-09-27" });
});

test("plan parser uses only explicit user-specified intervals and labels", () => {
  const milestones = parsePlan("Week 6: Mobility review; Day 7: Wound review", today);
  assert.equal(milestones[0].date, "2026-09-26");
  assert.equal(milestones[1].date, "2026-10-31");
  assert.equal(milestones[1].label, "Mobility review");
  assert.throws(() => parsePlan("See in about a week", today), /Milestone 1/);
  assert.throws(() => parsePlan("Week 999: Review", today), /730/);
  assert.throws(() => parsePlan("", today), /between 1 and 24/);
  assert.throws(() => parsePlan("Day 7: Review", "2026-02-30"), /valid surgery/);
});

test("case creation rejects duplicates, invalid codes, sides, and dates", () => {
  const p = patient();
  assert.equal(p.milestones.length, 2);
  assert.throws(() => createPatient(fields, [p], today), /already exists/);
  assert.throws(() => createPatient({ ...fields, code: "<script>" }, [], today), /code with/);
  assert.throws(() => createPatient({ ...fields, surgeryDate: "2030-01-01" }, [], today), /surgery date/);
  assert.throws(() => createPatient({ ...fields, side: "unknown" }, [], today), /side/);
});

test("overdue is not a no-show; today and future stay separate", () => {
  assert.equal(milestoneState({ status: "planned", date: "2026-09-18" }, today), "overdue");
  assert.equal(milestoneState({ status: "planned", date: today }, today), "today");
  assert.equal(milestoneState({ status: "planned", date: "2026-09-20" }, today), "upcoming");
  assert.equal(milestoneState({ status: "completed", date: "2026-09-18" }, today), "completed");
  assert.equal(milestoneState({ status: "missed", date: "2026-09-18" }, today), "missed");
  const tasks = attentionTasks(makeSeed(today), today);
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].patient.code, "DEMO-014");
  assert.equal(tasks[1].patient.code, "DEMO-023");
});

test("completion removes attention and records the actual date", () => {
  const patients = makeSeed(today);
  const p = patients[0], m = p.milestones[1];
  updateMilestone(p, m.id, "complete", today);
  assert.equal(m.status, "completed");
  assert.equal(m.completedDate, today);
  assert.equal(m.history.at(-1).previous.status, "missed");
  assert.equal(attentionTasks(patients, today).length, 1);
  assert.throws(() => updateMilestone(p, m.id, "complete", today), /Only open/);
});

test("no-shows never cascade dates and future no-shows are rejected", () => {
  const p = makeSeed(today)[1];
  const dates = p.milestones.map(m => m.date);
  updateMilestone(p, p.milestones[1].id, "miss", today);
  assert.equal(p.milestones[1].status, "missed");
  assert.deepEqual(p.milestones.map(m => m.date), dates);
  assert.throws(() => updateMilestone(p, p.milestones[2].id, "miss", today), /future visit/);
});

test("rescheduling preserves history and leaves other milestones unchanged", () => {
  const p = makeSeed(today)[0], m = p.milestones[1];
  const original = m.date;
  const otherDate = p.milestones[2].date;
  updateMilestone(p, m.id, "reschedule", today, "2026-09-22");
  assert.equal(m.status, "planned");
  assert.equal(m.date, "2026-09-22");
  assert.equal(m.history.at(-1).previous.date, original);
  assert.equal(m.history.at(-1).previous.status, "missed");
  assert.equal(p.milestones[2].date, otherDate);
  assert.throws(() => updateMilestone(p, m.id, "reschedule", today, "2026-09-01"), /Choose a date/);
  assert.throws(() => updateMilestone(p, m.id, "reschedule", today, m.date), /different date/);
});

test("outreach is a log, not resolution; cancellation is not completion", () => {
  const p = makeSeed(today)[0], m = p.milestones[1];
  updateMilestone(p, m.id, "contact", today);
  assert.equal(m.status, "missed");
  assert.equal(isOpen(m), true);
  updateMilestone(p, m.id, "cancel", today);
  assert.equal(m.status, "cancelled");
  assert.equal(m.completedDate, null);
  assert.equal(isOpen(m), false);
});

test("completion and rescheduling cannot precede surgery", () => {
  const p = createPatient({ ...fields, surgeryDate: "2026-09-25" }, [], today);
  assert.throws(() => updateMilestone(p, p.milestones[0].id, "complete", today), /before surgery/);
  assert.throws(() => updateMilestone(p, p.milestones[0].id, "reschedule", today, "2026-09-22"), /on or after/);
});

test("assistant intents are explicit and never mutate data", () => {
  const patients = makeSeed(today);
  const before = structuredClone(patients);
  assert.equal(parseAssistant("Who missed an appointment?", patients).intent, "attention");
  assert.equal(parseAssistant("What is due today?", patients).intent, "today");
  assert.deepEqual(parseAssistant("What is coming next week?", patients), { intent: "week", offset: 1 });
  assert.equal(parseAssistant("Show DEMO-014", patients).patientId, patients[0].id);
  assert.equal(parseAssistant("Show DEMO-999", patients).intent, "not-found");
  assert.equal(parseAssistant("What medication should I prescribe?", patients).intent, "help");
  const plan = parseAssistant(`Plan DEMO-042 on ${today}: Day 7: Wound review; Week 6: PT review`, patients);
  assert.equal(plan.intent, "plan");
  assert.equal(plan.surgeryDate, today);
  assert.deepEqual(patients, before);
});

test("weekly list includes completed outcomes but not cancelled milestones", () => {
  const patients = makeSeed(today);
  const list = weeklyTasks(patients, today);
  assert.ok(list.some(({ milestone }) => milestone.status === "completed"));
  assert.ok(list.every(({ milestone }) => milestone.date >= "2026-09-14" && milestone.date <= "2026-09-20"));
  const task = list[0];
  task.milestone.status = "cancelled";
  task.milestone.completedDate = null;
  assert.ok(!weeklyTasks(patients, today).some(({ milestone }) => milestone.id === task.milestone.id));
});

test("backup validation checks unique IDs, statuses, history, and dates", () => {
  const store = { version: 1, patients: makeSeed(today) };
  assert.deepEqual(validateStore(store), store);
  const duplicate = structuredClone(store);
  duplicate.patients.push(duplicate.patients[0]);
  assert.throws(() => validateStore(duplicate), /duplicate/);
  const malformed = structuredClone(store);
  malformed.patients[0].milestones[0].date = "2026-02-30";
  assert.throws(() => validateStore(malformed), /milestone/);
  const history = structuredClone(store);
  history.patients[0].milestones[1].history[0].previous = null;
  assert.throws(() => validateStore(history), /history/);
  assert.throws(() => validateStore({ version: 2, patients: [] }), /supported/);
});

test("calendar exports only open items with escaped text and exclusive end dates", () => {
  const p = patient();
  p.milestones[0].label = "Review, discussion; café\nFollow-up " + "é".repeat(60);
  p.milestones[1].status = "completed";
  p.milestones[1].completedDate = today;
  const content = makeCalendar(p.milestones.map(milestone => ({ patient: p, milestone })), today);
  assert.equal((content.match(/BEGIN:VEVENT/g) || []).length, 1);
  assert.match(content, /DTSTART;VALUE=DATE:20260926/);
  assert.match(content, /DTEND;VALUE=DATE:20260927/);
  assert.match(content, /Review\\, discussion\\; café\\nFollow-up/);
  assert.ok(content.split("\r\n").every(line => Buffer.byteLength(line) <= 75));
  assert.ok(content.endsWith("END:VCALENDAR\r\n"));
});
