import { PROCEDURES, formatDate, addDays, daysBetween, attentionTasks, weeklyTasks, isOpen, canUndoCompletion, milestoneState, createPatient } from "/domain.js";
import { patientsToCSV } from "/csv.js";

const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const state = { user: null, patients: [], revision: 0, today: "", view: "overview", query: "", ai: null, reply: null, settings: null, notice: "", error: "", completion: null, deployment: document.body.dataset.deployment || "local" };
let setupRequired = false, draft, fields, proposalRevision, confirmHandler, busy = false;
const hosted = () => state.deployment === "cloud";

async function api(path, body) {
  let response;
  try {
    response = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? {} : { "Content-Type": "application/json", "X-Aftercare": "1" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
  } catch { throw new Error("The server is not reachable. Saving was not confirmed. Check your connection, refresh, and review the records before retrying."); }
  let result;
  try { result = await response.json(); }
  catch { throw new Error("The server returned an unreadable response. No success was confirmed."); }
  if (!response.ok) {
    if (response.status === 401 && state.user) {
      state.user = null;
      for (const dialog of document.querySelectorAll("dialog[open]")) dialog.close();
      renderAuth();
    }
    throw new Error(result.error || `Request failed (${response.status}).`);
  }
  return result;
}

async function loadState() {
  const data = await api("/api/state");
  if (data.revision >= state.revision) Object.assign(state, data);
}

function showError(error) {
  const open = [...document.querySelectorAll("dialog[open]")].at(-1);
  const target = open?.querySelector("[data-error]") || $("#page-error") || $("#auth-error");
  if (target) {
    target.textContent = error.message;
    target.scrollIntoView({ block: "nearest" });
  }
}

function renderAuth() {
  if (hosted()) {
    $("#pilot").innerHTML = `<main id="main" class="auth-card"><div class="brand"><img src="/favicon.svg" width="36" height="36" alt="">aftercare.</div><h1>Opening the online demo.</h1><p>No sign-in is required. If the workspace did not load, check your connection and try again.</p><div id="auth-error" class="pilot-error" role="alert"></div><a class="button primary" href="/">Try again</a></main>`;
    return;
  }
  $("#pilot").innerHTML = `<main id="main" class="auth-card"><div class="brand"><img src="/favicon.svg" width="36" height="36" alt="">aftercare.</div><h1>${setupRequired ? "Set up your local pilot." : "Sign in to Aftercare."}</h1><p>Shared follow-ups, real local AI, and a daily review reminder.</p><p class="pilot-notice">Fictional cases only. This runs on your Mac—not the public GitHub page. It is not approved for clinical records.</p><form id="auth-form"><label class="field">Username<input name="username" minlength="3" maxlength="40" autocomplete="username" required></label><label class="field">Password<input name="password" type="password" minlength="12" maxlength="128" autocomplete="${setupRequired ? "new-password" : "current-password"}" required></label><p class="field-help">Use at least 12 characters. Keep your password outside this repository.</p><div id="auth-error" class="pilot-error" role="alert"></div><button class="button primary" type="submit">${setupRequired ? "Create clinician account" : "Sign in"}</button></form><p>${setupRequired ? "The first account manages plans, staff access, and reminders. Six fictional cases will be added." : "Your records are in the local shared database, not this browser’s storage."}</p></main>`;
}

function badge(m) {
  const status = milestoneState(m, state.today);
  const label = { completed: "Completed", missed: "Confirmed no-show", overdue: `${daysBetween(m.date, state.today)} days overdue`, today: "Due today", upcoming: "Upcoming", cancelled: "Cancelled" }[status];
  return `<span class="badge ${status}">${label}</span>`;
}

function row(patient, milestone) {
  return `<div class="task-row"><button class="task-open" data-action="patient" data-id="${patient.id}"><strong>${esc(patient.code)} · ${esc(milestone.label)}</strong><small>${formatDate(milestone.date, { year: "numeric" })} · ${esc(patient.procedure)} · ${esc(patient.side)}</small></button><div class="task-footer">${badge(milestone)}${isOpen(milestone) && patient.surgeryDate <= state.today ? `<button class="button secondary" data-action="complete" data-patient="${patient.id}" data-id="${milestone.id}" aria-label="Mark ${esc(patient.code)}: ${esc(milestone.label)} complete">Mark complete</button>` : ""}</div></div>`;
}

function notice() {
  const patient = state.patients.find(p => p.id === state.completion?.patientId);
  const milestone = patient?.milestones.find(m => m.id === state.completion?.milestoneId);
  return milestone && canUndoCompletion(milestone) ? `<div class="completion-notice"><span role="status">${esc(patient.code)} · ${esc(milestone.label)} marked complete.</span><button class="text-button" data-action="undo-complete" data-patient="${patient.id}" data-id="${milestone.id}">Undo completion</button></div>` : "";
}

function render() {
  if (!state.user) return renderAuth();
  const views = [["overview", "Overview"], ["patients", "Patients"], ["assistant", "AI assistant"], ...(state.user.role === "clinician" ? [["settings", "Reminders & storage"]] : [])];
  $("#pilot").innerHTML = `<div class="pilot-shell"><header class="pilot-header"><a class="brand" href="/"><img src="/favicon.svg" width="36" height="36" alt="">aftercare.</a><div><span>${hosted() ? "Public demo" : `${esc(state.user.username)} · ${esc(state.user.role)}`}</span><button class="button secondary" data-action="refresh">Refresh shared records</button>${hosted() ? "" : '<button class="text-button" data-action="logout">Sign out</button>'}</div></header>
    <div class="pilot-notice">${hosted() ? "<strong>Public demo · invented cases only.</strong> Anyone with this link can view and edit the shared records. Changes save online; do not enter real patient information. Gmail reminders go only to the configured owner." : `<strong>Single-surgeon pilot · fictional cases only.</strong> Your working records stay on this Mac; you can publish a fictional CSV snapshot to the public GitHub page. ${state.mailMode === "local-inbox" ? "Reminders go to the local test inbox—not your email." : "Gmail delivery is configured; check its status in Reminders & storage."}`}</div>
    <nav class="pilot-nav" aria-label="Main navigation">${views.map(([view, label]) => `<button data-action="navigate" data-view="${view}" class="${state.view === view ? "active" : ""}" ${state.view === view ? 'aria-current="page"' : ""}>${label}</button>`).join("")}</nav>
    <div id="page-error" class="pilot-error" role="alert">${esc(state.error)}</div><div class="pilot-success" role="status">${esc(state.notice)}</div>${notice()}<main id="main">${state.view === "overview" ? overview() : state.view === "patients" ? patientsView() : state.view === "assistant" ? assistantView() : settingsView()}</main><p class="pilot-footnote">Clinic dates use Massachusetts time (America/New_York). Attendance is entered by you—not inferred by AI. There is no EHR integration or patient messaging. ${hosted() ? "Free-service limits and outages can interrupt AI or reminders; check the worklist yourself. Open cases are kept. Fully completed or cancelled cases are removed after 30 days; provider recovery history can retain deleted data longer." : "The server must be running and this Mac awake for scheduled reminders."}</p></div>`;
}

function overview() {
  const attention = attentionTasks(state.patients, state.today);
  const due = weeklyTasks(state.patients, state.today).filter(({ milestone }) => isOpen(milestone) && milestone.date >= state.today);
  const active = state.patients.filter(p => p.milestones.some(isOpen)).length;
  return `<section class="page-heading"><div><p class="eyebrow">${formatDate(state.today, { year: "numeric", weekday: "long" })}</p><h1>Your postoperative follow-ups.</h1><p>Review open milestones, record attendance, and keep your plan current.</p></div>${state.user.role === "clinician" ? '<button class="button primary" data-action="new-case">Add a case</button>' : ""}</section>
    <section class="stats-grid" aria-label="Summary">${[["Needs attention", attention.length, "Overdue updates or confirmed no-shows"], ["Due today–Sunday", due.length, "Open milestones in the rest of this week"], ["Active cases", active, "At least one open milestone"]].map(([label, n, description]) => `<div class="stat-card"><span class="stat-label">${label}</span><strong class="stat-number">${n}</strong><span class="stat-description">${description}</span></div>`).join("")}</section>
    <section class="panel"><div class="panel-heading"><div><h2>Follow-ups needing attention</h2><p>Check the appointment record before marking a no-show.</p></div></div>${attention.length ? attention.map(({ patient, milestone }) => row(patient, milestone)).join("") : '<div class="empty-state">No overdue updates or recorded no-shows.</div>'}</section>
    <section class="panel"><div class="panel-heading"><h2>Due by Sunday</h2></div>${due.length ? due.map(({ patient, milestone }) => row(patient, milestone)).join("") : '<div class="empty-state">No more open milestones due this week.</div>'}</section>`;
}

function patientsView() {
  return `<section class="page-heading"><div><h1>Your surgical cases.</h1><p>Open a timeline to record a visit, no-show, reschedule, or outreach attempt.</p></div>${state.user.role === "clinician" ? '<button class="button primary" data-action="new-case">Add a case</button>' : ""}</section><label class="field">Find a case<input id="search" type="search" placeholder="Patient code or procedure" value="${esc(state.query)}"></label><div id="case-list" class="panel">${patientList()}</div>`;
}

function patientList() {
  const patients = state.patients.filter(p => `${p.code} ${p.procedure}`.toLowerCase().includes(state.query.toLowerCase()));
  return patients.length ? patients.map(p => `<div class="task-row"><button class="task-open" data-action="patient" data-id="${p.id}"><strong>${esc(p.code)}</strong><small>${esc(p.procedure)} · ${esc(p.side)} · Surgery ${formatDate(p.surgeryDate, { year: "numeric" })}</small></button><span>${p.milestones.filter(isOpen).length} open milestones</span></div>`).join("") : '<div class="empty-state">No matching cases.</div>';
}

function showPatient(id) {
  const patient = state.patients.find(p => p.id === id);
  if (!patient) throw new Error("This case no longer exists. Refresh the workspace.");
  const dialog = $("#patient-dialog");
  const position = dialog.scrollTop;
  dialog.innerHTML = `<div class="dialog-heading"><div><p class="eyebrow">SHARED RECOVERY TIMELINE</p><h2 id="patient-title">${esc(patient.code)}</h2></div><button class="icon-button" data-action="close" aria-label="Close patient">✕</button></div><p class="dialog-intro">${esc(patient.procedure)} · ${esc(patient.side)}<br>Surgery ${formatDate(patient.surgeryDate, { year: "numeric" })}</p><div class="pilot-error" data-error role="alert"></div><div class="pilot-success" id="patient-status" role="status"></div>
    ${hosted() && state.closedSince?.[patient.id] ? `<p class="pilot-notice warning">All milestones are closed. This fictional case is scheduled for removal on ${formatDate(addDays(state.closedSince[patient.id], 30), { year: "numeric" })}. Reopening a milestone resets the retention clock.</p>` : ""}
    ${[...patient.milestones].sort((a, b) => a.date.localeCompare(b.date)).map(m => `<section class="pilot-timeline-item" data-milestone="${m.id}"><h3>${esc(m.label)}</h3><p>${formatDate(m.date, { year: "numeric" })} · Post-op day ${daysBetween(patient.surgeryDate, m.date)}</p>${badge(m)}${m.completedDate ? `<p>Completed ${formatDate(m.completedDate, { year: "numeric" })}</p>` : ""}<div class="pilot-dialog-actions">
    ${isOpen(m) ? `${patient.surgeryDate <= state.today ? `<button class="button secondary" data-action="complete" data-patient="${id}" data-id="${m.id}">Mark complete</button>` : ""}<button class="button secondary" data-action="reschedule" data-patient="${id}" data-id="${m.id}">Reschedule</button>${m.date <= state.today && m.status !== "missed" ? `<button class="text-button" data-action="confirm-action" data-operation="miss" data-patient="${id}" data-id="${m.id}">Record confirmed no-show</button>` : ""}<button class="text-button" data-action="confirm-action" data-operation="contact" data-patient="${id}" data-id="${m.id}">Log outreach attempt</button>${state.user.role === "clinician" ? `<button class="text-button" data-action="confirm-action" data-operation="cancel" data-patient="${id}" data-id="${m.id}">Cancel milestone</button>` : ""}` : ""}
    ${canUndoCompletion(m) ? `<button class="text-button" data-action="undo-complete" data-patient="${id}" data-id="${m.id}">Undo completion</button>` : ""}</div>
    ${m.history.length ? `<details><summary>Recorded activity (${m.history.length})</summary><ul>${m.history.map(h => `<li>${esc(h.recordedBy || "Fictional example")} · ${formatDate(h.on)} · ${esc({ complete: "Completed", "undo-complete": "Completion undone", miss: "Confirmed no-show", contact: "Outreach attempt logged; no message sent", reschedule: `Rescheduled to ${h.newDate || ""}`, cancel: "Cancelled" }[h.action])}</li>`).join("")}</ul></details>` : ""}</section>`).join("")}`;
  if (!dialog.open) dialog.showModal();
  dialog.scrollTop = position;
}

function caseForm(prefill = {}, sources = []) {
  fields = prefill;
  draft = null;
  proposalRevision = state.revision;
  $("#case-dialog").innerHTML = `<div class="dialog-heading"><h2 id="case-title">Your postoperative plan</h2><button class="icon-button" data-action="close" aria-label="Close new case">✕</button></div><p class="dialog-intro">You choose the steps and timing. Review the dates before saving.</p>${sources.length ? `<div class="ai-sources"><strong>AI used these exact words from your request:</strong><ul>${sources.map(s => `<li>${esc(s)}</li>`).join("")}</ul></div>` : ""}<form id="case-form"><div class="form-grid"><label class="field">Fictional patient code<input name="code" maxlength="20" required value="${esc(prefill.code || "")}" placeholder="DEMO-077"></label><label class="field">Surgery date<input name="surgeryDate" type="date" value="${esc(prefill.surgeryDate || state.today)}" required></label><label class="field">Procedure<select name="procedure">${PROCEDURES.map(p => `<option ${p === prefill.procedure ? "selected" : ""}>${p}</option>`).join("")}</select></label><label class="field">Side<select name="side">${["Not specified", "Left", "Right", "Bilateral"].map(side => `<option ${side === prefill.side ? "selected" : ""}>${side}</option>`).join("")}</select></label></div><label class="field plan-field">Your milestones<textarea name="plan" rows="5" required placeholder="Day 7: Wound review&#10;Week 6: Mobility review">${esc(prefill.plan || "")}</textarea><span class="field-help">Use your own instructions: Day 7: Milestone or Week 6: Milestone. These are targets, not booked appointments.</span></label><div data-error class="pilot-error" role="alert"></div><div class="dialog-actions"><button class="button primary" type="submit">Preview dates</button></div></form>`;
  if (!$("#case-dialog").open) $("#case-dialog").showModal();
}

function preview(fieldsToPreview) {
  fields = fieldsToPreview;
  draft = createPatient(fields, state.patients, state.today);
  $("#case-dialog").innerHTML = `<div class="dialog-heading"><h2 id="case-title">Check every date</h2><button class="icon-button" data-action="close" aria-label="Close preview">✕</button></div><p class="dialog-intro">${esc(draft.code)} · ${esc(draft.procedure)} · ${esc(draft.side)}</p><div class="preview-list">${draft.milestones.map(m => `<div><span class="preview-check">✓</span><span><strong>${esc(m.label)}</strong><small>Post-op day ${daysBetween(draft.surgeryDate, m.date)}</small></span><strong>${formatDate(m.date, { year: "numeric" })}</strong></div>`).join("")}</div><p class="pilot-notice">Confirm only your intended plan. The AI does not decide care, book appointments, or contact a patient.</p><div data-error class="pilot-error" role="alert"></div><div class="dialog-actions"><button class="button secondary" data-action="edit-plan">Edit plan</button><button class="button primary" data-action="save-plan">Confirm & save shared plan</button></div>`;
}

function assistantView() {
  return `<section class="page-heading"><div><h1>Ask your ${hosted() ? "online" : "local"} AI assistant.</h1><p>Use everyday words to find follow-ups or draft your own plan.</p></div></section><p class="pilot-notice ${state.ai?.ready ? "" : "warning"}"><strong>${state.ai?.ready ? `Configured · ${esc(state.ai.model)}` : "AI connection"}</strong><br>${esc(state.ai?.message || "Checking the AI engine…")}</p><div class="ai-examples"><button data-action="example" data-prompt="Who needs my attention this week?">Who needs attention?</button><button data-action="example" data-prompt="What follow-ups are planned for next week?">Next week’s follow-ups</button>${state.user.role === "clinician" ? `<button data-action="example" data-prompt="DEMO-077 had surgery today. Wound review in 7 days, mobility review in 6 weeks.">Draft my own plan</button>` : ""}</div><form id="ai-form" class="ai-box"><label class="field">Your question or plan<textarea id="ai-prompt" name="prompt" maxlength="5000" required placeholder="Example: DEMO-077 had surgery today. Wound review in 7 days, mobility review in 6 weeks."></textarea></label><p class="field-help">Only the words you enter are sent to ${hosted() ? "Cloudflare's hosted model. Use fictional information only" : "the model on this Mac"}. AI interprets the request; saved-record lists and dates are computed by the app. It does not provide medical advice.</p><div class="heading-actions"><button class="button secondary" type="button" data-action="ai-status">Check connection</button><button class="button primary" type="submit">${hosted() ? "Ask AI" : "Ask local AI"}</button></div><p id="ai-progress" role="status"></p></form><section class="ai-response" aria-live="polite">${replyView()}</section>`;
}

function replyView() {
  const reply = state.reply;
  if (!reply) return "";
  return `<h2>${esc(reply.title)}</h2><p>${esc(reply.explanation)}</p><p class="connection">Interpreted by ${esc(reply.model)} · workspace revision ${reply.revision}. Ask again after changing a record.</p>${reply.kind === "tasks" ? `<div class="panel">${reply.tasks.length ? reply.tasks.map(t => `<div class="task-row"><button class="task-open" data-action="patient" data-id="${esc(t.patientId)}"><strong>${esc(t.code)} · ${esc(t.milestone.label)}</strong><small>${formatDate(t.milestone.date, { year: "numeric" })}</small></button>${badge(t.milestone)}</div>`).join("") : '<div class="empty-state">No matching milestones.</div>'}</div>` : reply.kind === "proposal" ? '<button class="button primary" data-action="review-ai">Review and edit draft</button>' : ""}`;
}

function settingsView() {
  const data = state.settings;
  if (hosted() && data) return cloudSettingsView(data);
  if (!data) return "<p>Loading team and reminder settings…</p>";
  return `<section class="page-heading"><div><h1>Reminders & storage.</h1><p>One surgeon. A local working copy and an optional public fictional snapshot.</p></div></section><div class="team-grid"><section class="settings-card"><h2>Daily review reminder</h2><p class="pilot-notice ${data.mailMode === "local-inbox" ? "warning" : ""}">${data.mailMode === "local-inbox" ? "LOCAL TEST INBOX: no emails leave this Mac. Connect SMTP in the private .env file for real delivery." : "SMTP connected. “Accepted” means the email server accepted the message—not a guarantee it reached your inbox."}</p><form id="reminder-form"><label class="check-field"><input type="checkbox" name="enabled" ${data.settings.enabled ? "checked" : ""}>Enable one daily reminder</label><label class="field">Time in Massachusetts<input name="time" type="time" required value="${esc(data.settings.time)}"></label><label class="field">${data.mailMode === "local-inbox" ? "Preview email address (not delivered)" : "Your reminder email"}<input name="recipient" type="email" required value="${esc(data.settings.recipient)}"></label><button class="button primary" type="submit">Save reminder settings</button></form><button class="text-button" data-action="test-email">${data.mailMode === "local-inbox" ? "Create test inbox message" : "Send test email"}</button><p>The server must stay running and this Mac awake. If started after the set time, today’s reminder is caught up once; previous days are not replayed. No patient codes or treatment details are included.</p></section>
    <section class="settings-card"><h2>Fictional CSV snapshots</h2><p>Your local database saves every update. A CSV snapshot can also be downloaded or published to <strong>Muddaqureshi/Aftercare-Muj-Podiatrist</strong>.</p><p class="pilot-notice warning"><strong>Public means public.</strong> Publishing includes every case, surgery date, and milestone in the snapshot. They remain in Git history. Use invented cases only—not coded real patients. Account names and passwords are excluded.</p><div class="pilot-dialog-actions"><button class="button secondary" data-action="download-csv">Download case CSV</button><button class="button primary" data-action="publish">Publish fictional data</button></div><p>The GitHub page can read the published snapshot from any device. Browser edits are not automatically uploaded. After publication, wait for deployment and select <strong>Load published cases</strong> on the public page.</p><p>Publishing uses this Mac’s signed-in GitHub CLI. No GitHub token is placed in the browser. The real AI and scheduler still run here on your Mac.</p></section></div>
    <section class="panel"><div class="panel-heading"><div><h2>${data.mailMode === "local-inbox" ? "Local reminder inbox" : "Reminder delivery log"}</h2><p>Failed or uncertain deliveries are not automatically retried. Check the inbox before sending again.</p></div></div>${data.reminders.length ? data.reminders.map(r => `<details class="mail-item"><summary><span class="badge ${r.status === "failed" || r.status === "uncertain" ? "missed" : "completed"}">${esc({ captured: "Local preview · not emailed", accepted: "Accepted by email server", failed: "Failed", uncertain: "Delivery uncertain", skipped: "No open work · skipped", sending: "Sending" }[r.status])}</span>${esc(r.subject)}<br>${esc(r.created_at)} · ${esc(r.recipient)}</summary>${r.error ? `<p class="pilot-error">${esc(r.error)}</p>` : ""}<pre>${esc(r.body)}</pre></details>`).join("") : '<div class="empty-state">No reminder runs yet. Create a test message to check the workflow.</div>'}</section>`;
}

function cloudSettingsView(data) {
  return `<section class="page-heading"><div><h1>Reminders & storage.</h1><p>Public fictional records. Private owner-managed email delivery.</p></div></section><div class="team-grid"><section class="settings-card"><h2>Daily owner reminder</h2><p>Scheduled reminders are <strong>${data.settings.enabled ? "enabled" : "disabled"}</strong>. The configured time is <strong>${esc(data.settings.time)} Massachusetts time</strong>.</p><p>The scheduler checks every 15 minutes and sends at most once per day when there is due or overdue work. It does not require the owner's computer to stay on.</p><p>The recipient address, credentials, and delivery log are private. Public visitors cannot change email settings or send test messages. Free-service limits or outages can interrupt delivery.</p></section><section class="settings-card"><h2>Shared records & automatic cleanup</h2><p>Anyone with this link can read and edit these cases. Saved changes go to the shared online database and can be seen from another device after refreshing. Records are not private, even though they are not committed to GitHub.</p><p>Open cases are kept. A case is removed 30 days after all milestones become completed or cancelled. Reopening resets the clock. Provider recovery history and downloaded copies have separate lifecycles.</p><p>Use invented cases only, never actual patient records.</p><button class="button secondary" data-action="download-csv">Download case CSV</button>${state.patients.length ? "" : '<button class="button secondary" data-action="load-demo">Load six fictional examples</button>'}</section></div>`;
}

async function change(operation, patientId, milestoneId, newDate, revision = state.revision) {
  const data = await api("/api/actions", { action: "milestone", operation, patientId, milestoneId, newDate, revision });
  Object.assign(state, data);
  state.completion = operation === "complete" ? { patientId, milestoneId } : null;
  state.notice = operation === "contact" ? "Your outreach attempt was recorded. No message was sent." : operation === "undo-complete" ? "Completion undone; the original status is restored." : "Update saved to the shared database.";
  render();
  if ($("#patient-dialog").open) {
    showPatient(patientId);
    $("#patient-status").textContent = state.notice;
  }
}

function confirmAction(operation, patientId, milestoneId) {
  const patient = state.patients.find(p => p.id === patientId);
  const milestone = patient?.milestones.find(m => m.id === milestoneId);
  if (!milestone) throw new Error("This milestone no longer exists.");
  const revision = state.revision;
  const titles = { miss: "Confirm the patient did not attend", contact: "Log an outreach attempt you made", cancel: "Cancel this planned milestone", reschedule: "Choose a new target date" };
  $("#confirm-dialog").innerHTML = `<div class="dialog-heading"><h2 id="confirm-title">${titles[operation]}</h2><button class="icon-button" data-action="close" aria-label="Close confirmation">✕</button></div><p>${esc(patient.code)} · ${esc(milestone.label)}</p><p>${operation === "miss" ? "Use this only after checking attendance. An overdue date alone is not a no-show." : operation === "contact" ? "This only records your attempt. No email, text, or call will be sent to the patient." : "Other milestone dates will not change."}</p>${operation === "reschedule" ? `<label class="field">New target date<input id="new-date" type="date" min="${state.today > patient.surgeryDate ? state.today : patient.surgeryDate}" required></label>` : ""}<div data-error class="pilot-error" role="alert"></div><div class="dialog-actions"><button class="button secondary" data-action="close">Go back</button><button class="button primary" data-action="confirm">Confirm update</button></div>`;
  confirmHandler = () => change(operation, patientId, milestoneId, operation === "reschedule" ? $("#new-date").value : undefined, revision);
  $("#confirm-dialog").showModal();
}

document.addEventListener("click", async event => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  event.preventDefault();
  if (busy && !["close"].includes(button.dataset.action)) return;
  const { action, id, patient, operation, view } = button.dataset;
  const locks = ["complete", "undo-complete", "confirm", "save-plan", "test-email", "logout"];
  if (locks.includes(action)) { busy = true; button.disabled = true; }
  try {
    if (action === "close") button.closest("dialog").close();
    else if (action === "logout") {
      await api("/api/logout", {});
      location.reload();
    } else if (action === "navigate") {
      state.view = view; state.notice = ""; state.error = "";
      if (view === "settings") state.settings = await api("/api/settings");
      if (view === "assistant") state.ai = await api("/api/ai/status");
      render();
    } else if (action === "refresh") {
      await loadState();
      if (state.view === "settings") state.settings = await api("/api/settings");
      state.notice = "Shared records refreshed."; state.error = ""; render();
    } else if (action === "patient") showPatient(id);
    else if (action === "new-case") caseForm();
    else if (action === "edit-plan") caseForm(fields);
    else if (action === "save-plan") {
      if (!draft) throw new Error("Preview the plan before confirming.");
      const result = await api("/api/actions", { action: "add-case", fields, revision: proposalRevision });
      Object.assign(state, result);
      $("#case-dialog").close(); state.notice = "Plan saved to the shared database."; draft = null; render();
    } else if (action === "complete" || action === "undo-complete") {
      await change(action, patient, id);
    } else if (action === "confirm-action") confirmAction(operation, patient, id);
    else if (action === "reschedule") confirmAction("reschedule", patient, id);
    else if (action === "confirm") {
      if (!confirmHandler) throw new Error("This confirmation expired.");
      await confirmHandler();
      $("#confirm-dialog").close(); confirmHandler = null;
    } else if (action === "example") {
      $("#ai-prompt").value = button.dataset.prompt; $("#ai-prompt").focus();
    } else if (action === "ai-status") {
      const prompt = $("#ai-prompt").value;
      state.ai = await api("/api/ai/status"); render();
      $("#ai-prompt").value = prompt;
    } else if (action === "review-ai") {
      await loadState();
      caseForm(state.reply.fields, state.reply.sources);
    } else if (action === "test-email") {
      const { reminder } = await api("/api/reminders/test", {});
      state.notice = reminder.status === "captured" ? "Test reminder captured locally. It was NOT emailed." : "Your email server accepted the test message. Check your inbox.";
      state.settings = await api("/api/settings"); render();
    } else if (action === "download-csv") {
      const url = URL.createObjectURL(new Blob([patientsToCSV(state.patients)], { type: "text/csv;charset=utf-8" }));
      const link = document.createElement("a");
      link.href = url; link.download = `aftercare-fictional-${state.today}.csv`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } else if (action === "load-demo" && hosted()) {
      const revision = state.revision;
      $("#confirm-dialog").innerHTML = '<div class="dialog-heading"><h2 id="confirm-title">Load fictional examples?</h2></div><p>Six invented cases will be saved to your empty online workspace. They are not postoperative protocols or actual patients.</p><div data-error class="pilot-error" role="alert"></div><div class="dialog-actions"><button class="button secondary" data-action="close">Cancel</button><button class="button primary" data-action="confirm">Load examples</button></div>';
      confirmHandler = async () => {
        Object.assign(state, await api("/api/actions", { action: "load-demo", revision, fictionalOnly: true }));
        state.notice = "Six fictional examples saved online."; render();
      };
      $("#confirm-dialog").showModal();
    } else if (action === "publish" && !hosted()) {
      const revision = state.revision;
      $("#confirm-dialog").innerHTML = `<div class="dialog-heading"><h2 id="confirm-title">Publish these fictional cases publicly?</h2><button class="icon-button" data-action="close" aria-label="Close publication">✕</button></div><p>All ${state.patients.length} cases, dates, and milestone records will be written to a CSV file in the public repository and retained in Git history.</p><label class="check-field"><input id="fictional-only" type="checkbox">Every case is invented and contains no real patient data.</label><div data-error class="pilot-error" role="alert"></div><div class="dialog-actions"><button class="button secondary" data-action="close">Cancel</button><button class="button primary" data-action="confirm">Confirm publication</button></div>`;
      confirmHandler = async () => {
        if (!$("#fictional-only").checked) throw new Error("Confirm that all cases are fictional.");
        await api("/api/publish", { revision, fictionalOnly: true });
        state.notice = `Fictional snapshot revision ${revision} committed to GitHub. Deployment may take a few minutes; then use “Load published cases” on the public page.`;
        render();
      };
      $("#confirm-dialog").showModal();
    }
  } catch (error) { showError(error); }
  finally { busy = false; if (button.isConnected) button.disabled = false; }
});

document.addEventListener("submit", async event => {
  event.preventDefault();
  if (busy) return;
  const form = event.target, values = Object.fromEntries(new FormData(form));
  const button = form.querySelector("[type='submit']");
  busy = true; if (button) button.disabled = true;
  try {
    if (form.id === "auth-form") {
      const result = await api(setupRequired ? "/api/setup" : "/api/login", values);
      state.user = result.user; setupRequired = false; await loadState(); render();
    } else if (form.id === "case-form") preview(values);
    else if (form.id === "ai-form") {
      $("#ai-progress").textContent = "The AI is reading your request. No records are being changed…";
      state.reply = await api("/api/assistant", values);
      $(".ai-response").innerHTML = replyView();
      $("#ai-progress").textContent = "Response ready. No records were changed.";
    } else if (form.id === "reminder-form") {
      await api("/api/settings", { enabled: values.enabled === "on", time: values.time, recipient: values.recipient });
      state.settings = await api("/api/settings"); state.notice = hosted() ? "Daily reminder settings saved online." : "Daily reminder settings saved. The server must stay running."; render();
    }
  } catch (error) {
    if ($("#ai-progress")) $("#ai-progress").textContent = "Request did not complete. No records were changed.";
    showError(error);
  } finally { busy = false; if (button?.isConnected) button.disabled = false; }
});
document.addEventListener("input", event => {
  if (event.target.id === "search") { state.query = event.target.value; $("#case-list").innerHTML = patientList(); }
});

try {
  const bootstrap = await api("/api/bootstrap");
  setupRequired = bootstrap.setupRequired;
  state.deployment = bootstrap.deployment || "local";
  state.user = bootstrap.user;
  if (state.user) await loadState();
  render();
} catch (error) {
  renderAuth(); showError(error);
}
