export const STORAGE_KEY = "aftercare.demo.v1";
export const PROCEDURES = ["Forefoot surgery", "Bunion correction", "Ankle repair", "Hindfoot surgery", "Tendon repair", "Other procedure"];
export const STATUSES = ["planned", "completed", "missed", "cancelled"];

export function localToday(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function addDays(value, amount) {
  if (!validDate(value) || !Number.isInteger(amount)) throw new Error("Use a valid calendar date and a whole number of days.");
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

export function daysBetween(from, to) {
  if (!validDate(from) || !validDate(to)) throw new Error("A calendar date is invalid.");
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86400000);
}

export function weekBounds(today, offset = 0) {
  const day = new Date(`${today}T12:00:00Z`).getUTCDay();
  const start = addDays(today, -(day === 0 ? 6 : day - 1) + offset * 7);
  return { start, end: addDays(start, 6) };
}

export function formatDate(value, options = {}) {
  if (!validDate(value)) throw new Error("Cannot display an invalid date.");
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC", ...options }).format(new Date(`${value}T12:00:00Z`));
}

export function uid() {
  return globalThis.crypto.randomUUID();
}

export function milestoneState(milestone, today) {
  if (milestone.status !== "planned") return milestone.status;
  if (milestone.date < today) return "overdue";
  if (milestone.date === today) return "today";
  return "upcoming";
}

export function isOpen(milestone) {
  return milestone.status === "planned" || milestone.status === "missed";
}

export function canUndoCompletion(milestone) {
  const last = milestone.history.at(-1);
  return milestone.status === "completed" && last?.action === "complete"
    && isOpen(last.previous) && last.previous.date === milestone.date
    && last.on === milestone.completedDate;
}

export function allTasks(patients) {
  return patients.flatMap(patient => patient.milestones.map(milestone => ({ patient, milestone })));
}

export function attentionTasks(patients, today) {
  return allTasks(patients)
    .filter(({ milestone: m }) => m.status === "missed" || (m.status === "planned" && m.date < today))
    .sort((a, b) => a.milestone.date.localeCompare(b.milestone.date) || a.patient.code.localeCompare(b.patient.code));
}

export function weeklyTasks(patients, today, offset = 0) {
  const { start, end } = weekBounds(today, offset);
  return allTasks(patients)
    .filter(({ milestone: m }) => m.date >= start && m.date <= end && m.status !== "cancelled")
    .sort((a, b) => a.milestone.date.localeCompare(b.milestone.date) || a.patient.code.localeCompare(b.patient.code));
}

export function nextMilestone(patient) {
  return patient.milestones.filter(isOpen).sort((a, b) => a.date.localeCompare(b.date))[0];
}

export function parsePlan(text, surgeryDate) {
  if (!validDate(surgeryDate)) throw new Error("Choose a valid surgery date first.");
  const lines = text.split(/[;\n]+/).map(line => line.trim()).filter(Boolean);
  if (!lines.length || lines.length > 24) throw new Error("Add between 1 and 24 milestones.");
  const milestones = lines.map((line, index) => {
    const match = line.match(/^(day|week)\s+(\d{1,3})\s*:\s*(.{2,100})$/i);
    if (!match) throw new Error(`Milestone ${index + 1}: use “Day 7: Your milestone” or “Week 6: Your milestone”.`);
    const offset = Number(match[2]) * (match[1].toLowerCase() === "week" ? 7 : 1);
    if (offset > 730) throw new Error("Milestones must be within 730 days of surgery.");
    return { id: uid(), label: match[3].trim(), date: addDays(surgeryDate, offset), status: "planned", completedDate: null, history: [] };
  });
  return milestones.sort((a, b) => a.date.localeCompare(b.date));
}

export function createPatient({ code, procedure, side, surgeryDate, plan }, patients, today) {
  code = code.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9-]{1,19}$/.test(code)) throw new Error("Use a code with 2–20 letters, numbers, or hyphens, starting with a letter.");
  if (patients.some(patient => patient.code === code)) throw new Error("That code already exists. Choose a different code.");
  if (!PROCEDURES.includes(procedure)) throw new Error("Choose a procedure.");
  if (!["Left", "Right", "Bilateral", "Not specified"].includes(side)) throw new Error("Choose a side.");
  if (!validDate(surgeryDate) || surgeryDate < "2000-01-01" || surgeryDate > addDays(today, 365)) throw new Error("Choose a surgery date between January 2000 and one year from today.");
  return { id: uid(), code, procedure, side, surgeryDate, createdDate: today, milestones: parsePlan(plan, surgeryDate) };
}

export function updateMilestone(patient, milestoneId, action, today, newDate) {
  const milestone = patient.milestones.find(item => item.id === milestoneId);
  if (!milestone) throw new Error("This milestone could not be found.");
  const previous = { status: milestone.status, date: milestone.date, completedDate: milestone.completedDate };
  if (["complete", "miss", "cancel", "contact", "reschedule"].includes(action) && !isOpen(milestone)) throw new Error("Only open milestones can be changed.");
  if (action === "complete") {
    if (patient.surgeryDate > today) throw new Error("A postoperative milestone cannot be completed before surgery.");
    milestone.status = "completed";
    milestone.completedDate = today;
  } else if (action === "undo-complete") {
    if (!canUndoCompletion(milestone)) throw new Error("This completion can no longer be undone. Review the current timeline.");
    const original = milestone.history.at(-1).previous;
    milestone.status = original.status;
    milestone.completedDate = null;
  } else if (action === "miss") {
    if (milestone.date > today) throw new Error("A future visit cannot be marked as a no-show.");
    milestone.status = "missed";
  } else if (action === "reschedule") {
    if (!validDate(newDate) || newDate < today || newDate < patient.surgeryDate || newDate > addDays(today, 730)) throw new Error("Choose a date on or after today and surgery, within the next two years.");
    if (newDate === milestone.date) throw new Error("Choose a different date to reschedule.");
    milestone.date = newDate;
    milestone.status = "planned";
    milestone.completedDate = null;
  } else if (action === "cancel") {
    milestone.status = "cancelled";
  } else if (action !== "contact") {
    throw new Error("This action is not supported.");
  }
  milestone.history.push({ action, on: today, previous, ...(action === "reschedule" ? { newDate } : {}) });
  return milestone;
}

export function parseAssistant(text, patients) {
  const input = text.trim();
  if (!input || input.length > 2500) return { intent: "help" };
  const plan = input.match(/^plan\s+([a-z][a-z0-9-]{1,19})\s+on\s+(\d{4}-\d{2}-\d{2})\s*:\s*([\s\S]+)$/i);
  if (plan) return { intent: "plan", code: plan[1].toUpperCase(), surgeryDate: plan[2], plan: plan[3] };
  if (/\b(overdue|missed|no.shows?|attention|behind|track.*down)\b/i.test(input)) return { intent: "attention" };
  if (/\btoday\b/i.test(input)) return { intent: "today" };
  if (/\b(next week)\b/i.test(input)) return { intent: "week", offset: 1 };
  if (/\b(week|reminders?|upcoming|due|today)\b/i.test(input)) return { intent: "week", offset: 0 };
  const codeMatch = input.match(/\b(?:open|show|find)\s+([a-z][a-z0-9-]{1,19})\b/i);
  if (codeMatch) {
    const patient = patients.find(item => item.code === codeMatch[1].toUpperCase());
    return patient ? { intent: "patient", patientId: patient.id } : { intent: "not-found", code: codeMatch[1].toUpperCase() };
  }
  return { intent: "help" };
}

export function makeSeed(today) {
  const specs = [
    ["DEMO-014", "Bunion correction", "Left", -18, [[7, "First postoperative visit", "completed"], [14, "Wound review", "missed"], [28, "Recovery review", "planned"], [42, "Mobility & PT discussion", "planned"]]],
    ["DEMO-023", "Ankle repair", "Right", -24, [[7, "First postoperative visit", "completed"], [21, "Cast & recovery review", "planned"], [35, "Surgeon-directed mobility review", "planned"]]],
    ["DEMO-008", "Forefoot surgery", "Left", -14, [[7, "Wound review", "completed"], [14, "Postoperative follow-up", "planned"], [28, "Recovery review", "planned"]]],
    ["DEMO-031", "Tendon repair", "Right", -11, [[7, "First postoperative visit", "completed"], [14, "Recovery & dressing review", "planned"], [42, "Physical therapy review", "planned"]]],
    ["DEMO-019", "Hindfoot surgery", "Left", -39, [[14, "Postoperative follow-up", "completed"], [35, "Recovery review", "completed"], [42, "Mobility plan review", "planned"]]],
    ["DEMO-005", "Forefoot surgery", "Right", -45, [[7, "First postoperative visit", "completed"], [21, "Recovery review", "completed"], [42, "Final planned follow-up", "completed"]]]
  ];
  return specs.map(([code, procedure, side, offset, milestones]) => {
    const surgeryDate = addDays(today, offset);
    return {
      id: uid(), code, procedure, side, surgeryDate, createdDate: surgeryDate,
      milestones: milestones.map(([day, label, status]) => ({
        id: uid(), label, date: addDays(surgeryDate, day), status,
        completedDate: status === "completed" ? addDays(surgeryDate, day) : null,
        history: status === "missed" ? [{ action: "miss", on: addDays(surgeryDate, day), previous: { status: "planned", date: addDays(surgeryDate, day), completedDate: null } }] : []
      }))
    };
  });
}

export function validateStore(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.patients) || value.patients.length > 500) throw new Error("This is not a supported Aftercare demo backup.");
  const ids = new Set();
  const codes = new Set();
  const checkedId = id => {
    if (typeof id !== "string" || !/^[a-zA-Z0-9-]{1,64}$/.test(id) || ids.has(id)) throw new Error("The backup contains an invalid or duplicate identifier.");
    ids.add(id);
  };
  const text = (item, max) => typeof item === "string" && item.length > 0 && item.length <= max;
  for (const p of value.patients) {
    if (!p || typeof p !== "object") throw new Error("Invalid patient entry.");
    checkedId(p.id);
    if (!text(p.code, 20) || !/^[A-Z][A-Z0-9-]{1,19}$/.test(p.code) || codes.has(p.code)) throw new Error("Invalid or duplicate patient code.");
    codes.add(p.code);
    if (!PROCEDURES.includes(p.procedure) || !["Left", "Right", "Bilateral", "Not specified"].includes(p.side) || !validDate(p.surgeryDate) || !validDate(p.createdDate)) throw new Error("The backup contains an invalid case.");
    if (!Array.isArray(p.milestones) || p.milestones.length < 1 || p.milestones.length > 24) throw new Error("The backup contains an invalid plan.");
    for (const m of p.milestones) {
      if (!m || typeof m !== "object") throw new Error("Invalid milestone entry.");
      checkedId(m.id);
      if (!text(m.label, 100) || !validDate(m.date) || m.date < p.surgeryDate || !STATUSES.includes(m.status) || !Array.isArray(m.history) || m.history.length > 1000) throw new Error("The backup contains an invalid milestone.");
      if (m.completedDate !== null && (!validDate(m.completedDate) || m.completedDate < p.surgeryDate)) throw new Error("The backup contains an invalid completion date.");
      if ((m.status === "completed") !== (m.completedDate !== null)) throw new Error("A completed milestone needs an actual completion date.");
      for (const event of m.history) {
        if (!event || !["complete", "undo-complete", "miss", "reschedule", "cancel", "contact"].includes(event.action) || !validDate(event.on) || !event.previous || !STATUSES.includes(event.previous.status) || !validDate(event.previous.date) || (event.previous.completedDate !== null && !validDate(event.previous.completedDate)) || (event.action === "reschedule" && !validDate(event.newDate))) throw new Error("The backup contains invalid history.");
      }
    }
  }
  return structuredClone(value);
}

export function makeCalendar(tasks, today) {
  const escape = value => value.replace(/\\/g, "\\\\").replace(/\r?\n/g, "\\n").replace(/;/g, "\\;").replace(/,/g, "\\,");
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Aftercare//Fictional Demo//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH"];
  for (const { patient, milestone } of tasks.filter(({ milestone }) => isOpen(milestone))) {
    lines.push("BEGIN:VEVENT", `UID:${milestone.id}@aftercare-demo`, `DTSTAMP:${today.replaceAll("-", "")}T120000Z`, `DTSTART;VALUE=DATE:${milestone.date.replaceAll("-", "")}`, `DTEND;VALUE=DATE:${addDays(milestone.date, 1).replaceAll("-", "")}`, `SUMMARY:${escape(`${patient.code}: ${milestone.label}`)}`, "DESCRIPTION:Fictional Aftercare demo. Planned date only; not a confirmed appointment.", "TRANSP:TRANSPARENT", "END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  // Fold by UTF-8 octets, not JavaScript character count (RFC 5545).
  const encoder = new TextEncoder();
  return lines.map(line => {
    let output = "", width = 0;
    for (const char of line) {
      const size = encoder.encode(char).length;
      if (width + size > 75) { output += "\r\n "; width = 1; }
      output += char;
      width += size;
    }
    return output;
  }).join("\r\n") + "\r\n";
}
