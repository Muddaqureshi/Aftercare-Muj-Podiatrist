import { validateStore } from "./domain.js";

const columns = ["patient_id", "patient_code", "procedure", "side", "surgery_date", "created_date", "milestone_id", "milestone", "target_date", "status", "completed_date", "history_json"];
const encode = value => {
  let text = String(value ?? "");
  if (/^[=+\-@\t\r']/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
};
const decode = text => /^'[=+\-@\t\r']/.test(text) ? text.slice(1) : text;

export function patientsToCSV(patients) {
  validateStore({ version: 1, patients });
  const rows = [columns.map(encode).join(",")];
  for (const p of patients) {
    for (const m of p.milestones) {
      // Account identities are deliberately excluded from public snapshots.
      const history = m.history.map(({ action, on, previous, newDate }) => ({ action, on, previous, ...(newDate ? { newDate } : {}) }));
      rows.push([p.id, p.code, p.procedure, p.side, p.surgeryDate, p.createdDate, m.id, m.label, m.date, m.status, m.completedDate || "", JSON.stringify(history)].map(encode).join(","));
    }
  }
  return rows.join("\r\n") + "\r\n";
}

export function patientsFromCSV(input) {
  if (typeof input !== "string" || input.length > 2000000) throw new Error("The CSV snapshot is missing or exceeds 2 MB.");
  const text = input.replace(/^\uFEFF/, "");
  const rows = [];
  let row = [], cell = "", quoted = false, closed = false;
  const endCell = () => { row.push(decode(cell)); cell = ""; closed = false; };
  const endRow = () => { endCell(); if (row.some(value => value !== "")) rows.push(row); row = []; };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (char === '"') { quoted = false; closed = true; }
      else cell += char;
    } else if (char === '"') {
      if (cell || closed) throw new Error("The CSV contains an invalid quote.");
      quoted = true;
    } else if (char === ",") endCell();
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      endRow();
    } else {
      if (closed) throw new Error("Unexpected text after a quoted CSV field.");
      cell += char;
    }
  }
  if (quoted) throw new Error("The CSV has an unclosed quote.");
  if (cell || row.length || closed) endRow();
  if (!rows.length || JSON.stringify(rows[0]) !== JSON.stringify(columns) || rows.length > 12001) throw new Error("This is not an Aftercare case CSV.");
  const patients = new Map();
  for (const cells of rows.slice(1)) {
    if (cells.length !== columns.length) throw new Error("A CSV row has the wrong number of columns.");
    const [id, code, procedure, side, surgeryDate, createdDate, milestoneId, label, date, status, completedDate, historyText] = cells;
    const identity = { id, code, procedure, side, surgeryDate, createdDate };
    let patient = patients.get(id);
    if (!patient) { patient = { ...identity, milestones: [] }; patients.set(id, patient); }
    else if (Object.entries(identity).some(([key, value]) => patient[key] !== value)) throw new Error("Conflicting patient details in the CSV.");
    let history;
    try { history = JSON.parse(historyText); }
    catch { throw new Error("A CSV activity history is invalid."); }
    patient.milestones.push({ id: milestoneId, label, date, status, completedDate: completedDate || null, history });
  }
  return validateStore({ version: 1, patients: [...patients.values()] }).patients;
}
