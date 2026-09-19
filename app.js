import {
  STORAGE_KEY, PROCEDURES, localToday, addDays, daysBetween, weekBounds, formatDate,
  milestoneState, isOpen, canUndoCompletion, allTasks, attentionTasks, weeklyTasks, nextMilestone,
  createPatient, updateMilestone, parseAssistant, makeSeed, validateStore, makeCalendar
} from "./domain.js";

const $ = selector => document.querySelector(selector);
const esc = value => String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const paths = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
  people: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.87M15 3.13a4 4 0 0 1 0 7.75"/><circle cx="9" cy="7" r="4"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18m-14 5h3m4 0h3"/>',
  spark: '<path d="m12 3 2.6 6.4L21 12l-6.4 2.6L12 21l-2.6-6.4L3 12l6.4-2.6L12 3Z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  alert: '<path d="m10.3 4-8 14a2 2 0 0 0 1.7 3h16a2 2 0 0 0 1.7-3l-8-14a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4m0 4h.01"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4"/>',
  print: '<path d="M7 8V3h10v5M7 17H3V9h18v8h-4"/><path d="M7 14h10v7H7zm10-3h.01"/>',
  leaf: '<path d="M20 4c-2 12-6 15-11 12S4 6 20 4Z"/><path d="M4 21 14 11"/>',
  shield: '<path d="m12 3 8 4v5c0 5-8 9-8 9s-8-4-8-9V7l8-4Z"/><path d="m8 12 3 3 5-6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10h.01"/>',
  reset: '<path d="M3 10a9 9 0 1 1 1 8M3 3v7h7"/>',
  upload: '<path d="M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5"/>'
};
const icon = (name, className = "") => `<svg class="icon ${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.info}</svg>`;
const state = { today: localToday(), patients: [], view: "overview", filter: "all", query: "", weekOffset: 0 };
let startupError = "";
let toastTimer;
let draft = null;
let draftFields = null;
let pendingConfirmation = null;
let lastFocus = null;
let recentCompletion = null;
const messages = [];

try {
  const stored = localStorage.getItem(STORAGE_KEY);
  state.patients = stored ? validateStore(JSON.parse(stored)).patients : makeSeed(state.today);
  if (!stored) localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, patients: state.patients }));
} catch (error) {
  startupError = `Browser data could not be loaded or saved: ${error.message}. Fictional examples are shown. Changes are disabled until you reset the demo or enable browser storage.`;
  state.patients = makeSeed(state.today);
}

function commit(patients, reset = false) {
  if (startupError && !reset) throw new Error("Resolve the browser storage problem or reset the demo before saving changes.");
  const data = validateStore({ version: 1, patients });
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    throw new Error("Your change was NOT saved. Browser storage is unavailable or full. Export a backup before clearing storage, or enable storage and try again.");
  }
  state.patients = data.patients;
  startupError = "";
  render();
}

function toast(text, error = false) {
  clearTimeout(toastTimer);
  const element = $("#toast");
  element.textContent = text;
  element.className = `toast${error ? " error" : ""}`;
  element.setAttribute("role", error ? "alert" : "status");
  element.hidden = false;
  toastTimer = setTimeout(() => { element.hidden = true; }, error ? 12000 : 5000);
}

function openDialog(id) {
  const dialog = $(id);
  if (!dialog.open) {
    lastFocus = document.activeElement;
    dialog.showModal();
  }
}

function closeDialog(dialog) {
  dialog.close();
  if (lastFocus?.isConnected) lastFocus.focus();
}

function badge(milestone) {
  const status = milestoneState(milestone, state.today);
  const labels = { missed: "Confirmed no-show", overdue: `${daysBetween(milestone.date, state.today)}d overdue`, today: "Due today", upcoming: "Upcoming", completed: "Completed", cancelled: "Cancelled" };
  return `<span class="badge ${status}">${icon(status === "completed" ? "check" : status === "missed" || status === "overdue" ? "alert" : "clock")}${labels[status]}</span>`;
}

function postOp(patient) {
  const days = daysBetween(patient.surgeryDate, state.today);
  return days < 0 ? `Surgery in ${-days}d` : `Post-op day ${days}`;
}

function avatar(patient, large = false) {
  return `<span class="avatar ${large ? "large" : ""} tone-${Number(patient.code.replace(/\D/g, "").slice(-1) || 0) % 4}" aria-hidden="true">${esc(patient.code.slice(-2))}</span>`;
}

function empty(title, text, symbol = "check") {
  return `<div class="empty-state">${icon(symbol)}<h3>${title}</h3><p>${text}</p></div>`;
}

function taskRow({ patient, milestone }) {
  return `<div class="task-row">
    <button class="task-open" data-action="patient" data-id="${patient.id}" aria-label="Open ${esc(patient.code)}: ${esc(milestone.label)}">
    ${avatar(patient)}
    <span class="task-person"><strong>${esc(patient.code)}</strong><span>${esc(patient.procedure)} · ${esc(patient.side)}</span></span>
    <span class="task-milestone"><strong>${esc(milestone.label)}</strong><span>${formatDate(milestone.date)} · ${postOp(patient)}</span></span>
    </button>
    <div class="task-footer">${badge(milestone)}
      ${isOpen(milestone) && patient.surgeryDate <= state.today ? `<button class="button small secondary" data-action="complete" data-patient="${patient.id}" data-id="${milestone.id}" aria-label="Mark ${esc(patient.code)}: ${esc(milestone.label)} complete">${icon("check")} Mark complete</button>` : ""}
      ${canUndoCompletion(milestone) ? `<button class="text-button" data-action="undo-complete" data-patient="${patient.id}" data-id="${milestone.id}">Undo completion</button>` : ""}
    </div>
  </div>`;
}

function completionNotice() {
  const patient = state.patients.find(p => p.id === recentCompletion?.patientId);
  const milestone = patient?.milestones.find(m => m.id === recentCompletion?.milestoneId);
  if (!milestone || !canUndoCompletion(milestone)) return "";
  return `<div class="completion-notice"><span role="status"><strong>${esc(patient.code)}</strong> · ${esc(milestone.label)} marked complete.</span><button class="text-button" data-action="undo-complete" data-patient="${patient.id}" data-id="${milestone.id}">Undo completion</button><button class="icon-button" data-action="dismiss-completion" aria-label="Dismiss completion update">${icon("close")}</button></div>`;
}

function recordCompletion(patientId, milestoneId, undo = false) {
  const patients = structuredClone(state.patients);
  const patient = patients.find(p => p.id === patientId);
  if (!patient) throw new Error("This case no longer exists.");
  updateMilestone(patient, milestoneId, undo ? "undo-complete" : "complete", state.today);
  commit(patients);
  recentCompletion = undo ? null : { patientId, milestoneId };
  render();
  if ($("#patient-dialog").open) {
    const scrollTop = $("#patient-dialog").scrollTop;
    showPatient(patientId);
    $("#patient-dialog").scrollTop = scrollTop;
    $("#patient-feedback").textContent = undo ? "Completion undone. The previous status and date are restored." : "Marked complete. You can undo this below.";
    $(`[data-milestone="${milestoneId}"] [data-action="${undo ? "complete" : "undo-complete"}"]`)?.focus({ preventScroll: true });
  } else if (undo) {
    toast("Completion undone. The previous status and date are restored.");
    $(`.task-footer [data-action="complete"][data-id="${milestoneId}"]`)?.focus({ preventScroll: true });
  } else {
    $(".completion-notice [data-action='undo-complete']")?.focus({ preventScroll: true });
  }
}

function render() {
  const attention = attentionTasks(state.patients, state.today);
  const week = weekBounds(state.today);
  const nav = [
    ["overview", "grid", "Overview"],
    ["patients", "people", "Patients"],
    ["week", "calendar", "Weekly brief"]
  ];
  $("#app").innerHTML = `
    <aside class="sidebar">
      <a class="brand" href="#" data-action="navigate" data-view="overview"><img src="./favicon.svg" width="38" height="38" alt=""><span>aftercare<span class="brand-dot">.</span></span></a>
      <div class="workspace-label">THE RECOVERY WORKSPACE</div>
      <nav aria-label="Main navigation">${nav.map(([view, symbol, label]) => `<button class="nav-item ${state.view === view ? "active" : ""}" data-action="navigate" data-view="${view}" ${state.view === view ? 'aria-current="page"' : ""}>${icon(symbol)}<span class="nav-label">${label}</span>${view === "overview" && attention.length ? `<span class="nav-count">${attention.length}</span>` : ""}</button>`).join("")}</nav>
      <div class="sidebar-note"><span class="mini-mark">${icon("leaf")}</span><h3>A little less to<br>keep in your head.</h3><p>Your plans, follow-ups, and loose ends. One calm place.</p><button class="text-button" data-action="assistant">Meet your assistant ${icon("arrow")}</button></div>
      <div class="sidebar-bottom"><span class="local-indicator"></span><span>Saved in this browser<small>No account or cloud sync</small></span><button class="icon-button" aria-label="About this demo" data-action="about">${icon("info")}</button></div>
    </aside>
    <div class="workspace">
      <header class="topbar"><div><span class="practice-icon">${icon("plus")}</span><span>Podiatry workspace</span><span class="divider">/</span><span class="muted">${nav.find(item => item[0] === state.view)[2]}</span></div><button class="assistant-top" data-action="assistant">${icon("spark")}<span>Ask Aftercare</span><kbd>⌘ K</kbd></button></header>
      <div class="demo-banner">${icon("info")}<span><strong>Fictional demo.</strong> Use sample codes only—not real patient data. Plans stay in this browser.</span><button data-action="about">How it works ${icon("arrow")}</button></div>
      ${startupError ? `<div class="storage-error" role="alert">${esc(startupError)} <button class="text-button" data-action="reset">Reset demo</button></div>` : ""}
      ${completionNotice()}
      <main id="main" tabindex="-1">
        ${state.view === "overview" ? renderOverview(attention, week) : state.view === "patients" ? renderPatients() : renderWeek()}
      </main>
      <footer><span>Thoughtfully organized. Clinician directed.</span><div><button data-action="export">Export backup</button><button data-action="import">Restore backup</button><button data-action="reset">Reset demo</button></div></footer>
    </div><input id="import-file" type="file" accept=".json,application/json" hidden>`;
}

function renderOverview(attention, week) {
  const weekly = weeklyTasks(state.patients, state.today);
  const due = weekly.filter(({ milestone }) => isOpen(milestone) && milestone.date >= state.today);
  const completed = weekly.filter(({ milestone }) => milestone.status === "completed").length;
  const active = state.patients.filter(patient => patient.milestones.some(isOpen)).length;
  const upcoming = allTasks(state.patients).filter(({ milestone }) => milestone.status === "planned" && milestone.date >= state.today).sort((a, b) => a.milestone.date.localeCompare(b.milestone.date)).slice(0, 3);
  const taskList = state.filter === "week" ? due : attention;
  return `
    <section class="page-heading"><div><p class="eyebrow">${formatDate(state.today, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}</p><h1>Your postoperative follow-ups.</h1><p>Add a patient code and your milestones. Check what’s due, record updates, and spend less time tracking follow-ups.</p></div><button class="button primary" data-action="new-case">${icon("plus")} Add a case</button></section>
    <section class="stats-grid" aria-label="Workspace summary">
      <button class="stat-card attention-stat" data-action="filter" data-filter="all"><span class="stat-label">Needs attention ${icon("alert")}</span><span class="stat-number">${attention.length}<span class="stat-unit">milestone${attention.length === 1 ? "" : "s"}</span></span><span class="stat-description">Overdue or confirmed no-show ${icon("arrow")}</span></button>
      <button class="stat-card" data-action="filter" data-filter="week"><span class="stat-label">Due today–Sunday ${icon("calendar")}</span><span class="stat-number">${due.length}<span class="stat-unit">milestone${due.length === 1 ? "" : "s"}</span></span><span class="stat-description">Open · ${formatDate(state.today)} – ${formatDate(week.end)} ${icon("arrow")}</span></button>
      <button class="stat-card" data-action="navigate" data-view="patients"><span class="stat-label">Active recoveries ${icon("people")}</span><span class="stat-number">${active}<span class="stat-unit">cases</span></span><span class="stat-description">With open plan milestones ${icon("arrow")}</span></button>
      <div class="stat-card"><span class="stat-label">This week’s completed ${icon("check")}</span><span class="stat-number">${completed}<span class="stat-unit">milestone${completed === 1 ? "" : "s"}</span></span><span class="stat-description">From the ${formatDate(week.start)}–${formatDate(week.end)} plan ${icon("check")}</span></div>
    </section>
    <div class="overview-grid">
      <section class="panel attention-panel"><div class="panel-heading"><div><h2>${state.filter === "week" ? "Due by Sunday" : "Follow-ups needing attention"}</h2><p>Open a case, or mark a finished milestone complete.</p></div><span class="small-icon amber">${icon("clock")}</span></div>
        <div class="tabs" role="group" aria-label="Milestone list"><button data-action="filter" data-filter="all" class="${state.filter !== "week" ? "selected" : ""}" aria-pressed="${state.filter !== "week"}">Needs attention <span>${attention.length}</span></button><button data-action="filter" data-filter="week" class="${state.filter === "week" ? "selected" : ""}" aria-pressed="${state.filter === "week"}">Due by Sunday <span>${due.length}</span></button></div>
        <div class="task-list">${taskList.length ? taskList.map(taskRow).join("") : empty(state.filter === "week" ? "Nothing else due this week." : "No loose ends. Nicely done.", state.filter === "week" ? "Look ahead in your weekly brief." : "All past-due milestones have been accounted for.")}</div>
        <div class="panel-footnote">${icon("info")}Overdue means an update is missing—not necessarily a missed appointment.</div>
      </section>
      <section class="assistant-card"><div class="assistant-orbit" aria-hidden="true"><div>${icon("spark")}</div><span class="orbit-dot one"></span><span class="orbit-dot two"></span></div><span class="eyebrow">YOUR PLAN, ORGANIZED</span><h2>Ask about your<br>follow-ups.</h2><p>See what’s due, find missing updates, or turn your written plan into a timeline.</p><button class="assistant-example" data-action="assistant" data-prompt="What needs my attention?">“Who needs my attention?” ${icon("arrow")}</button><button class="button light" data-action="assistant">${icon("spark")} Ask Aftercare</button><span class="assistant-disclosure">Local demo assistant · no AI model connected</span></section>
    </div>
    <section class="upcoming-section"><div class="section-heading"><div><span class="eyebrow">ONE STEP AHEAD</span><h2>Coming up next</h2></div><button class="text-button" data-action="navigate" data-view="week">View weekly brief ${icon("arrow")}</button></div><div class="upcoming-grid">${upcoming.length ? upcoming.map(({ patient, milestone }) => `<button class="upcoming-card" data-action="patient" data-id="${patient.id}"><div class="upcoming-top"><span class="date-tile"><strong>${formatDate(milestone.date, { day: "numeric", month: undefined })}</strong><span>${formatDate(milestone.date, { month: "short", day: undefined })}</span></span><span>${badge(milestone)}</span></div><h3>${esc(milestone.label)}</h3><p>${esc(patient.code)} <span>·</span> ${esc(patient.procedure)}</p><div class="upcoming-bottom"><span>${postOp(patient)}</span>${icon("arrow")}</div></button>`).join("") : empty("Your schedule is clear.", "Add a fictional case to explore a recovery plan.", "calendar")}</div></section>`;
}

function renderPatients() {
  return `<section class="page-heading"><div><p class="eyebrow">PATIENT PLANS</p><h1>Your surgical cases.</h1><p>Find a patient code and review the next planned milestone.</p></div><button class="button primary" data-action="new-case">${icon("plus")} Add a case</button></section>
    <section class="panel"><div class="patient-toolbar"><h2>Your cases <span class="count-pill">${state.patients.length}</span></h2><label class="search-box">${icon("search")}<input id="patient-search" type="search" placeholder="Find a code or procedure…" aria-label="Search patient codes or procedures" value="${esc(state.query)}"></label></div><div id="patient-results">${patientResults()}</div></section>`;
}

function patientResults() {
  const filtered = state.patients.filter(p => `${p.code} ${p.procedure} ${p.side}`.toLowerCase().includes(state.query.toLowerCase()));
  return filtered.length ? `<div class="patient-table"><div class="table-head"><span>CASE / PROCEDURE</span><span>RECOVERY</span><span>NEXT OPEN MILESTONE</span><span>STATUS</span></div>${filtered.map(patient => {
    const next = nextMilestone(patient);
    const completed = patient.milestones.filter(m => m.status === "completed").length;
    return `<button class="patient-row" data-action="patient" data-id="${patient.id}"><span class="patient-cell">${avatar(patient)}<span><strong>${esc(patient.code)}</strong><small>${esc(patient.procedure)} · ${esc(patient.side)}</small></span></span><span><strong>${postOp(patient)}</strong><small>${completed}/${patient.milestones.length} completed</small></span><span><strong>${next ? esc(next.label) : "No open milestones"}</strong><small>${next ? formatDate(next.date, { year: "numeric" }) : "Plan accounted for"}</small></span><span>${next ? badge(next) : '<span class="badge completed">No open items</span>'}${icon("chevron")}</span></button>`;
  }).join("")}</div>` : empty("No matching cases.", "Try another code or procedure.", "search");
}

function renderWeek() {
  const { start, end } = weekBounds(state.today, state.weekOffset);
  const tasks = weeklyTasks(state.patients, state.today, state.weekOffset);
  const open = tasks.filter(({ milestone }) => isOpen(milestone)).length;
  const completed = tasks.filter(({ milestone }) => milestone.status === "completed").length;
  const unresolved = attentionTasks(state.patients, state.today).filter(({ milestone }) => milestone.date < start);
  return `<section class="page-heading"><div><p class="eyebrow">YOUR WEEKLY BRIEF</p><h1>${state.weekOffset === 0 ? "This week’s follow-ups." : "Weekly follow-ups."}</h1><p>Planned milestones—not booked appointments.</p></div><div class="heading-actions"><button class="button secondary" data-action="calendar">${icon("download")} Calendar</button><button class="button primary" data-action="print">${icon("print")} Print brief</button></div></section>
    <section class="panel weekly-panel"><div class="week-heading"><button class="icon-button" data-action="week-prev" aria-label="Previous week">${icon("chevron", "rotate")}</button><div><h2>${formatDate(start)} – ${formatDate(end, { year: "numeric" })}</h2><span>${state.weekOffset === 0 ? "This week" : state.weekOffset === 1 ? "Next week" : state.weekOffset === -1 ? "Last week" : "Selected week"} · ${tasks.length} planned milestone${tasks.length === 1 ? "" : "s"}</span></div><button class="icon-button" data-action="week-next" aria-label="Next week">${icon("chevron")}</button>${state.weekOffset !== 0 ? '<button class="text-button" data-action="week-today">This week</button>' : ""}</div>
    <div class="week-summary"><span><strong>${open}</strong> still open</span><span><strong>${completed}</strong> completed</span><p>By planned date. Open items include overdue updates and no-shows.</p></div>
    ${unresolved.length ? `<div class="carryover"><h3>${icon("alert")} Unresolved from before this week <span>${unresolved.length}</span></h3><p>Still needs a recorded outcome; nothing has been automatically moved.</p>${unresolved.map(taskRow).join("")}</div>` : ""}
    ${tasks.length ? Array.from({ length: 7 }, (_, i) => addDays(start, i)).map(day => {
      const dayTasks = tasks.filter(({ milestone }) => milestone.date === day);
      return `<div class="day-group ${day === state.today ? "is-today" : ""}"><div class="day-heading"><span>${formatDate(day, { weekday: "short", month: undefined, day: undefined })}</span><strong>${formatDate(day, { day: "numeric", month: undefined })}</strong>${day === state.today ? '<span class="today-dot">Today</span>' : ""}</div><div class="day-tasks">${dayTasks.length ? dayTasks.map(taskRow).join("") : '<p class="quiet-day">No planned milestones.</p>'}</div></div>`;
    }).join("") : empty("A quieter week.", "No milestones are planned in this date range.", "calendar")}</section><p class="page-note">The brief updates when you open Aftercare. It does not send reminders, check attendance, or monitor your appointment system in the background.</p>`;
}

function showPatient(id) {
  const patient = state.patients.find(item => item.id === id);
  if (!patient) throw new Error("This case no longer exists.");
  const completed = patient.milestones.filter(m => m.status === "completed").length;
  $("#patient-dialog").innerHTML = `<div class="drawer-top"><span class="eyebrow">RECOVERY TIMELINE</span><button class="icon-button" data-action="close" aria-label="Close patient">${icon("close")}</button></div>
    <p id="patient-feedback" class="patient-feedback" role="status"></p>
    <div class="patient-title">${avatar(patient, true)}<div><h2 id="patient-title">${esc(patient.code)}</h2><p>${esc(patient.procedure)} · ${esc(patient.side)}</p></div></div>
    <div class="case-facts"><div><span>Surgery date</span><strong>${formatDate(patient.surgeryDate, { year: "numeric" })}</strong></div><div><span>Recovery</span><strong>${postOp(patient)}</strong></div><div><span>Completed</span><strong>${completed} of ${patient.milestones.length}</strong></div></div>
    <div class="plan-note">${icon("info")}Fictional, clinician-entered plan. Dates are targets, not confirmed appointments or treatment recommendations.</div>
    <div class="timeline"><div class="timeline-item surgery"><span class="timeline-node">${icon("plus")}</span><div><span class="timeline-date">${formatDate(patient.surgeryDate)}</span><h3>Surgery${patient.surgeryDate > state.today ? " planned" : ""}</h3><p>The starting point for this recovery plan.</p></div></div>
    ${[...patient.milestones].sort((a, b) => a.date.localeCompare(b.date)).map(m => {
      const status = milestoneState(m, state.today);
      const contact = [...m.history].reverse().find(h => h.action === "contact");
      return `<div class="timeline-item ${status}" data-milestone="${m.id}"><span class="timeline-node">${icon(status === "completed" ? "check" : status === "overdue" || status === "missed" ? "alert" : "clock")}</span><div class="timeline-content"><div class="timeline-date">${formatDate(m.date, { year: "numeric" })} <span>· Day ${daysBetween(patient.surgeryDate, m.date)}</span></div><h3>${esc(m.label)}</h3>${badge(m)}
      ${m.completedDate ? `<p class="actual-date">Completed ${formatDate(m.completedDate, { year: "numeric" })}</p>` : ""}
      ${status === "overdue" ? '<p class="timeline-explanation">No outcome recorded. Check attendance before marking a no-show.</p>' : status === "missed" ? '<p class="timeline-explanation">No-show recorded. Review and arrange follow-up yourself.</p>' : ""}
      ${contact ? `<p class="contact-note">${icon("check")} Outreach attempt logged ${formatDate(contact.on)}. No message was sent by Aftercare.</p>` : ""}
      ${isOpen(m) ? `<div class="milestone-actions">${patient.surgeryDate <= state.today ? `<button class="button small secondary" data-action="complete" data-patient="${patient.id}" data-id="${m.id}">${icon("check")} Mark complete</button>` : ""}<button class="text-button" data-action="reschedule" data-patient="${patient.id}" data-id="${m.id}">Reschedule</button><details class="action-menu"><summary aria-label="More actions for ${esc(m.label)}">More</summary><div>${m.status !== "missed" && m.date <= state.today ? `<button data-action="milestone" data-patient="${patient.id}" data-id="${m.id}" data-operation="miss">Record confirmed no-show</button>` : ""}<button data-action="milestone" data-patient="${patient.id}" data-id="${m.id}" data-operation="contact">Log outreach attempt</button><button data-action="milestone" data-patient="${patient.id}" data-id="${m.id}" data-operation="cancel">Cancel milestone</button></div></details></div>` : ""}
      ${canUndoCompletion(m) ? `<div class="milestone-actions"><button class="text-button" data-action="undo-complete" data-patient="${patient.id}" data-id="${m.id}">${icon("reset")} Undo completion</button></div>` : ""}
      ${m.history.length ? `<details class="history"><summary>Activity history (${m.history.length})</summary><ul>${m.history.map(h => `<li>${formatDate(h.on)} · ${esc(({ complete: "Marked completed", "undo-complete": "Completion undone; previous status restored", miss: "Confirmed no-show recorded", contact: "Outreach attempt logged", cancel: "Cancelled", reschedule: `Rescheduled from ${formatDate(h.previous.date)} to ${h.newDate ? formatDate(h.newDate) : ""}` })[h.action])}</li>`).join("")}</ul></details>` : ""}</div></div>`;
    }).join("")}</div><div class="drawer-bottom">${icon("shield")}Patient codes alone do not guarantee de-identification.</div>`;
  openDialog("#patient-dialog");
}

function confirmation({ title, content, label = "Confirm", onConfirm }) {
  pendingConfirmation = onConfirm;
  $("#confirm-dialog").innerHTML = `<div class="dialog-heading"><h2 id="confirm-title">${title}</h2><button class="icon-button" data-action="close" aria-label="Close confirmation">${icon("close")}</button></div>${content}<p class="form-error" id="confirm-error" role="alert"></p><div class="dialog-actions"><button class="button secondary" data-action="close">Go back</button><button class="button primary" data-action="confirm">${label}</button></div>`;
  openDialog("#confirm-dialog");
}

function changeMilestone(patientId, milestoneId, operation) {
  const patient = state.patients.find(p => p.id === patientId);
  const milestone = patient?.milestones.find(m => m.id === milestoneId);
  if (!milestone) throw new Error("This milestone no longer exists.");
  const titles = { miss: "Record a confirmed no-show?", cancel: "Cancel this milestone?", contact: "Log your outreach attempt?" };
  const explanations = {
    miss: "Use this only if you have confirmed the patient did not attend. No dates will move and no message will be sent.",
    cancel: "This removes the milestone from open worklists while preserving its history. Other dates will not change.",
    contact: "This records that you attempted contact yourself. Aftercare does not send messages. The milestone stays open until resolved."
  };
  confirmation({
    title: titles[operation],
    content: `<p><strong>${esc(patient.code)} · ${esc(milestone.label)}</strong></p><p>${explanations[operation]}</p>`,
    label: operation === "miss" ? "Record no-show" : operation === "cancel" ? "Cancel milestone" : "Log attempt",
    onConfirm: () => {
      const patients = structuredClone(state.patients);
      const current = patients.find(p => p.id === patientId);
      if (!current) throw new Error("This case no longer exists.");
      updateMilestone(current, milestoneId, operation, state.today);
      commit(patients);
      showPatient(patientId);
      toast("Update saved in this browser.");
    }
  });
}

function reschedule(patientId, milestoneId) {
  const patient = state.patients.find(p => p.id === patientId);
  const milestone = patient?.milestones.find(m => m.id === milestoneId);
  if (!milestone) throw new Error("This milestone no longer exists.");
  confirmation({
    title: "Choose a new target date",
    content: `<p><strong>${esc(patient.code)} · ${esc(milestone.label)}</strong></p><p>Currently ${formatDate(milestone.date, { year: "numeric" })}. Only this milestone will move; its history will be preserved.</p><label class="field">New date<input id="reschedule-date" type="date" min="${state.today > patient.surgeryDate ? state.today : patient.surgeryDate}" max="${addDays(state.today, 730)}" value="${addDays(state.today > patient.surgeryDate ? state.today : patient.surgeryDate, 7)}" required></label>`,
    label: "Save new date",
    onConfirm: () => {
      const newDate = $("#reschedule-date").value;
      const patients = structuredClone(state.patients);
      const current = patients.find(p => p.id === patientId);
      if (!current) throw new Error("This case no longer exists.");
      updateMilestone(current, milestoneId, "reschedule", state.today, newDate);
      commit(patients);
      showPatient(patientId);
      toast("New target date saved. No appointment was booked.");
    }
  });
}

function showCaseForm(fields = {}) {
  draft = null;
  draftFields = fields;
  $("#case-dialog").innerHTML = `<div class="dialog-heading"><div><p class="eyebrow">A CLEAR START</p><h2 id="case-title">Add a recovery plan</h2></div><button class="icon-button" data-action="close" aria-label="Close new case">${icon("close")}</button></div><p class="dialog-intro">You set the course. Aftercare keeps the milestones in view.</p>
    <div class="form-notice">${icon("info")}Fictional demo only. Use a sample code, not a name, MRN, or a code linked to a real patient.</div>
    <form id="case-form">
      <div class="form-grid"><label class="field">Sample patient code<input name="code" placeholder="e.g. DEMO-042" maxlength="20" pattern="[A-Za-z][A-Za-z0-9-]{1,19}" value="${esc(fields.code || "")}" required autocomplete="off"></label><label class="field">Surgery date<input name="surgeryDate" type="date" value="${esc(fields.surgeryDate || state.today)}" min="2000-01-01" max="${addDays(state.today, 365)}" required></label><label class="field">Procedure<select name="procedure">${PROCEDURES.map(p => `<option ${fields.procedure === p ? "selected" : ""}>${p}</option>`).join("")}</select></label><label class="field">Side<select name="side">${["Left", "Right", "Bilateral", "Not specified"].map(side => `<option ${fields.side === side ? "selected" : ""}>${side}</option>`).join("")}</select></label></div>
      <label class="field plan-field">Your postoperative milestones<span class="field-help">One per line: <strong>Day 7: Milestone</strong> or <strong>Week 6: Milestone</strong>. Timing is yours—not generated by Aftercare.</span><textarea name="plan" rows="5" maxlength="4000" placeholder="Day 7: Your first planned review&#10;Week 3: Your next planned review" required>${esc(fields.plan || "")}</textarea></label>
      <button class="text-button" type="button" data-action="sample-plan">${icon("plus")} Insert a fictional example</button><p class="form-error" id="case-error" role="alert"></p><div class="dialog-actions"><button class="button secondary" type="button" data-action="close">Cancel</button><button class="button primary" type="submit">Preview timeline ${icon("arrow")}</button></div>
    </form>`;
  openDialog("#case-dialog");
}

function previewCase(fields) {
  draftFields = fields;
  draft = createPatient(fields, state.patients, state.today);
  $("#case-dialog").innerHTML = `<div class="dialog-heading"><div><p class="eyebrow">REVIEW BEFORE SAVING</p><h2 id="case-title">Your plan, mapped out.</h2></div><button class="icon-button" data-action="close" aria-label="Close preview">${icon("close")}</button></div><p class="dialog-intro"><strong>${esc(draft.code)}</strong> · ${esc(draft.procedure)} · ${esc(draft.side)}<br>Surgery ${formatDate(draft.surgeryDate, { year: "numeric" })}</p><div class="preview-list">${draft.milestones.map(m => `<div><span class="preview-check">${icon("check")}</span><span><strong>${esc(m.label)}</strong><small>Post-op day ${daysBetween(draft.surgeryDate, m.date)}</small></span><strong>${formatDate(m.date, { year: "numeric" })}</strong></div>`).join("")}</div><p class="form-notice">${icon("info")}Review every date. Nothing is booked or sent; these are your planned targets. Existing plans are not changed.</p><p class="form-error" id="case-error" role="alert"></p><div class="dialog-actions"><button class="button secondary" data-action="edit-draft">Edit plan</button><button class="button primary" data-action="save-case">${icon("check")} Confirm & add case</button></div>`;
  openDialog("#case-dialog");
}

function showAssistant(prompt) {
  if (!messages.length) messages.push({
    role: "assistant",
    html: `<p>A little less to keep in your head.</p><p>I can list upcoming milestones, flag missing updates, and map <em>your</em> written plan into dates. What would help right now?</p>`
  });
  $("#assistant-dialog").innerHTML = `<div class="drawer-top"><div class="assistant-identity"><span class="small-icon teal">${icon("spark")}</span><div><h2 id="assistant-title">Ask Aftercare</h2><span>Your recovery planning companion</span></div></div><button class="icon-button" data-action="close" aria-label="Close assistant">${icon("close")}</button></div>
    <div class="assistant-limit">${icon("info")}Local, rule-based demo—not a connected AI model. No clinical advice, live attendance checks, or background reminders.</div>
    <div id="messages" class="messages" role="log" aria-label="Assistant conversation" aria-live="polite"></div>
    <div class="assistant-suggestions"><button data-action="ask" data-prompt="What's coming up this week?">This week ${icon("arrow")}</button><button data-action="ask" data-prompt="Who is overdue or missed a visit?">Needs attention ${icon("arrow")}</button><button data-action="assistant-plan">Map a plan ${icon("plus")}</button></div>
    <form id="assistant-form"><label for="assistant-input" class="sr-only">Ask the demo assistant</label><textarea id="assistant-input" rows="2" maxlength="2500" placeholder="What needs my attention this week?" required></textarea><button class="send-button" type="submit" aria-label="Send message">${icon("arrow")}</button></form><p class="assistant-footer">Fictional sample data only · Nothing sent to an AI provider</p>`;
  renderMessages();
  openDialog("#assistant-dialog");
  if (prompt) respond(prompt);
}

function renderMessages() {
  $("#messages").innerHTML = messages.map(m => `<div class="message ${m.role}">${m.role === "assistant" ? `<span class="message-mark">${icon("spark")}</span>` : ""}<div>${m.html}</div></div>`).join("");
  $("#messages").scrollTop = $("#messages").scrollHeight;
}

function assistantTaskList(tasks) {
  return `<div class="chat-task-list">${tasks.map(({ patient, milestone }) => `<button data-action="patient" data-id="${patient.id}"><span><strong>${esc(patient.code)}</strong> · ${esc(milestone.label)}</span><small>${formatDate(milestone.date, { year: "numeric" })} · ${milestoneState(milestone, state.today) === "overdue" ? "Outcome unrecorded" : esc(milestoneState(milestone, state.today))}</small>${icon("chevron")}</button>`).join("")}</div>`;
}

function respond(text) {
  messages.push({ role: "user", html: `<p>${esc(text)}</p>` });
  const intent = parseAssistant(text, state.patients);
  let html;
  if (intent.intent === "attention") {
    const tasks = attentionTasks(state.patients, state.today);
    html = tasks.length ? `<p><strong>${tasks.length} milestone${tasks.length === 1 ? "" : "s"} need attention.</strong> Here’s the oldest first.</p>${assistantTaskList(tasks)}<p class="chat-note">Overdue means no outcome is recorded. Confirm attendance yourself before recording a no-show. I haven’t contacted anyone or changed a date.</p>` : "<p><strong>No overdue milestones or recorded no-shows.</strong> Every past-due milestone has an outcome recorded.</p>";
  } else if (intent.intent === "today") {
    const tasks = allTasks(state.patients).filter(({ milestone }) => milestone.date === state.today && milestone.status !== "cancelled");
    html = `<p><strong>Today, ${formatDate(state.today)}</strong></p>${tasks.length ? `<p>${tasks.length} planned milestone${tasks.length === 1 ? "" : "s"}, including recorded outcomes:</p>${assistantTaskList(tasks)}` : "<p>No milestones planned today.</p>"}<button class="text-button" data-action="ask" data-prompt="Show overdue milestones">Check older unresolved items ${icon("arrow")}</button>`;
  } else if (intent.intent === "week") {
    const { start, end } = weekBounds(state.today, intent.offset);
    const tasks = weeklyTasks(state.patients, state.today, intent.offset);
    const overdue = attentionTasks(state.patients, state.today).length;
    html = `<p><strong>${formatDate(start)} – ${formatDate(end)}</strong></p><p>${tasks.length ? `${tasks.length} milestone${tasks.length === 1 ? "" : "s"} on the plan, including recorded outcomes:` : "No milestones planned in this week."}</p>${tasks.length ? assistantTaskList(tasks) : ""}${overdue ? `<p class="chat-note">Across all dates, ${overdue} milestone${overdue === 1 ? "" : "s"} still need attention.</p><button class="text-button" data-action="ask" data-prompt="Show overdue milestones">See unresolved milestones ${icon("arrow")}</button>` : ""}`;
  } else if (intent.intent === "patient") {
    const patient = state.patients.find(p => p.id === intent.patientId);
    html = `<p><strong>${esc(patient.code)}</strong> · ${postOp(patient)}<br>${esc(patient.procedure)} · ${esc(patient.side)}</p><button class="button small secondary" data-action="patient" data-id="${patient.id}">Open recovery timeline ${icon("arrow")}</button>`;
  } else if (intent.intent === "not-found") {
    html = `<p>I couldn’t find <strong>${esc(intent.code)}</strong>. Check the code in Patients; I won’t guess who you mean.</p>`;
  } else if (intent.intent === "plan") {
    try {
      createPatient({ ...intent, procedure: PROCEDURES[0], side: "Not specified" }, state.patients, state.today);
      html = `<p>I read a plan for <strong>${esc(intent.code)}</strong>, with surgery on <strong>${formatDate(intent.surgeryDate, { year: "numeric" })}</strong>.</p><p>Nothing has been saved. Choose the procedure and side, then review the dates before confirming.</p><button class="button small secondary" data-action="chat-plan" data-code="${esc(intent.code)}" data-date="${intent.surgeryDate}" data-plan="${esc(intent.plan)}">Review this plan ${icon("arrow")}</button>`;
    } catch (error) {
      html = `<p>I couldn’t map this plan: ${esc(error.message)}</p><p>Please adjust it and try again. Nothing was saved.</p>`;
    }
  } else {
    html = `<p>I can help with a few specific tasks in this demo. Try:</p><ul><li>“What’s coming up this week?”</li><li>“Who is overdue?”</li><li>“Show DEMO-014”</li></ul><p>To map a plan, use this format:</p><code class="plan-example">Plan DEMO-042 on ${state.today}: Day 7: My planned review; Week 3: My next review</code><p class="chat-note">Dates and treatments must come from you. I can’t infer a treatment plan, interpret clinical questions, or change milestones by chat.</p>`;
  }
  messages.push({ role: "assistant", html });
  renderMessages();
  $("#assistant-input").value = "";
}

function download(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function about() {
  confirmation({
    title: "A calmer workflow. An honest demo.",
    content: `<div class="about-copy"><p><strong>What works:</strong> code-based cases, your milestone dates, recorded outcomes, overdue lists, a weekly brief, calendar exports, and a local rule-based assistant.</p><p><strong>Where data lives:</strong> this browser’s local storage on this device. No records are committed to GitHub, sent to a server, or shared with an AI provider. Anyone using this browser profile can access them. Clearing site data removes them; exported backups are unencrypted.</p><p><strong>What this is not:</strong> a secured clinical record, an EHR integration, a connected AI model, or an automated reminder service. It cannot tell whether someone attended unless you record it.</p><p><strong>Codes are not automatic de-identification.</strong> Dates and a re-identifiable code can still be protected health information. Use fictional data here. Real use needs an appropriate deployment and de-identification/compliance review.</p><p>All example schedules are fictional interface demonstrations, not postoperative protocols. Clinical decisions remain yours.</p></div>`,
    label: "Got it",
    onConfirm: () => {}
  });
}

document.addEventListener("click", async event => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  event.preventDefault();
  const { action, id, view, filter, patient, operation, prompt } = button.dataset;
  try {
    if (action === "navigate") {
      state.view = view;
      state.filter = "all";
      render();
      $("#main").focus({ preventScroll: true });
      window.scrollTo({ top: 0 });
    } else if (action === "filter") {
      state.filter = filter;
      render();
      $(".attention-panel").scrollIntoView({ block: "nearest", behavior: "smooth" });
      $(`.tabs [data-filter="${filter}"]`).focus({ preventScroll: true });
    } else if (action === "patient") {
      showPatient(id);
    } else if (action === "new-case") {
      showCaseForm();
    } else if (action === "close") {
      closeDialog(button.closest("dialog"));
    } else if (action === "assistant") {
      showAssistant(prompt);
    } else if (action === "ask") {
      respond(prompt);
    } else if (action === "assistant-plan") {
      respond("How do I enter my own plan?");
      $("#assistant-input").value = `Plan DEMO-042 on ${state.today}: Day 7: My planned review; Week 3: My next review`;
      $("#assistant-input").focus();
    } else if (action === "chat-plan") {
      showCaseForm({ code: button.dataset.code, surgeryDate: button.dataset.date, plan: button.dataset.plan, side: "Not specified" });
    } else if (action === "sample-plan") {
      $('[name="plan"]').value = "Day 7: First planned review\nWeek 3: Recovery review\nWeek 6: Review next steps";
      toast("Fictional example inserted—not a recommended clinical protocol.");
    } else if (action === "edit-draft") {
      showCaseForm(draftFields);
    } else if (action === "save-case") {
      if (!draft || !draftFields) throw new Error("Preview a plan before saving.");
      const current = createPatient(draftFields, state.patients, state.today);
      commit([...state.patients, current]);
      closeDialog($("#case-dialog"));
      draft = null;
      showPatient(current.id);
      toast("Case added. Your timeline is saved in this browser.");
    } else if (action === "milestone") {
      changeMilestone(patient, id, operation);
    } else if (action === "complete" || action === "undo-complete") {
      recordCompletion(patient, id, action === "undo-complete");
    } else if (action === "dismiss-completion") {
      recentCompletion = null;
      render();
      $("#main").focus({ preventScroll: true });
    } else if (action === "reschedule") {
      reschedule(patient, id);
    } else if (action === "confirm") {
      const handler = pendingConfirmation;
      if (!handler) throw new Error("This confirmation is no longer active.");
      await handler();
      closeDialog($("#confirm-dialog"));
      pendingConfirmation = null;
    } else if (action === "week-prev" || action === "week-next" || action === "week-today") {
      state.weekOffset = action === "week-today" ? 0 : state.weekOffset + (action === "week-next" ? 1 : -1);
      render();
      $(`[data-action="${action === "week-today" ? "week-next" : action}"]`).focus({ preventScroll: true });
    } else if (action === "print") {
      window.print();
    } else if (action === "calendar") {
      const tasks = weeklyTasks(state.patients, state.today, state.weekOffset).filter(({ milestone }) => isOpen(milestone));
      if (!tasks.length) throw new Error("This week has no open milestones to export.");
      confirmation({
        title: "Export open milestones?",
        content: `<p>${tasks.length} all-day calendar item${tasks.length === 1 ? "" : "s"} will include sample codes and milestone labels. No appointment is booked and no reminder is sent.</p><p>A calendar service may sync imported files to its cloud. Export fictional data only. Re-importing a file may create duplicates; this is not a live subscription.</p>`,
        label: "Download calendar",
        onConfirm: () => download(`aftercare-${weekBounds(state.today, state.weekOffset).start}.ics`, makeCalendar(tasks, state.today), "text/calendar;charset=utf-8")
      });
    } else if (action === "export") {
      download(`aftercare-demo-backup-${state.today}.json`, JSON.stringify({ version: 1, patients: state.patients }, null, 2), "application/json");
      toast("Fictional demo backup downloaded. The file is not encrypted.");
    } else if (action === "import") {
      $("#import-file").click();
    } else if (action === "reset") {
      confirmation({
        title: "Reset to fictional examples?",
        content: "<p>This replaces all data saved by Aftercare in this browser with six fictional cases, dated relative to today. Export a backup first if you want to keep your demo work.</p>",
        label: "Reset demo",
        onConfirm: () => {
          commit(makeSeed(state.today), true);
          messages.length = 0;
          for (const dialog of document.querySelectorAll("dialog[open]:not(#confirm-dialog)")) dialog.close();
          toast("Fresh fictional examples loaded.");
        }
      });
    } else if (action === "about") {
      about();
    }
  } catch (error) {
    const target = $("#confirm-dialog").open ? $("#confirm-error") : $("#case-dialog").open ? $("#case-error") : $("#patient-dialog").open ? $("#patient-feedback") : null;
    if (target) {
      target.textContent = error.message;
      target.setAttribute("role", "alert");
      target.scrollIntoView({ block: "nearest" });
    }
    else toast(error.message, true);
  }
});

document.addEventListener("submit", event => {
  event.preventDefault();
  if (event.target.id === "case-form") {
    try { previewCase(Object.fromEntries(new FormData(event.target))); }
    catch (error) { $("#case-error").textContent = error.message; }
  } else if (event.target.id === "assistant-form") {
    const value = $("#assistant-input").value.trim();
    if (value) respond(value);
  }
});

document.addEventListener("input", event => {
  if (event.target.id === "patient-search") {
    state.query = event.target.value;
    $("#patient-results").innerHTML = patientResults();
  }
});

document.addEventListener("change", async event => {
  if (event.target.id !== "import-file") return;
  const file = event.target.files[0];
  if (!file) return;
  try {
    if (file.size > 2000000) throw new Error("Choose an Aftercare JSON backup smaller than 2 MB.");
    const data = validateStore(JSON.parse(await file.text()));
    confirmation({
      title: "Restore this demo backup?",
      content: `<p>This replaces the ${state.patients.length} cases in this browser with ${data.patients.length} cases from the selected file. It does not merge records. Restore fictional data only.</p>`,
      label: "Replace & restore",
      onConfirm: () => {
        commit(data.patients, true);
        messages.length = 0;
        toast("Demo backup restored in this browser.");
      }
    });
  } catch (error) {
    toast(`Backup not restored: ${error.message}`, true);
  } finally {
    event.target.value = "";
  }
});

document.addEventListener("keydown", event => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    showAssistant();
    $("#assistant-input").focus();
  }
  if (event.target.id === "assistant-input" && event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $("#assistant-form").requestSubmit();
  }
});

window.addEventListener("storage", event => {
  if (event.key !== STORAGE_KEY) return;
  try {
    if (!event.newValue) throw new Error("Saved data was removed in another tab. Reload or reset the demo.");
    state.patients = validateStore(JSON.parse(event.newValue)).patients;
    startupError = "";
    for (const dialog of document.querySelectorAll("dialog[open]")) dialog.close();
    messages.length = 0;
    draft = null;
    pendingConfirmation = null;
    render();
    toast("Workspace refreshed after a change in another tab. Reopen any unsaved plan.");
  } catch (error) {
    startupError = error.message;
    render();
    toast(error.message, true);
  }
});

function refreshDate() {
  const today = localToday();
  if (today !== state.today) {
    state.today = today;
    render();
    for (const dialog of document.querySelectorAll("dialog[open]")) dialog.close();
    messages.length = 0;
    toast("A new day: your worklists have been refreshed.");
  }
}
window.addEventListener("focus", refreshDate);
setInterval(refreshDate, 60000);
render();
