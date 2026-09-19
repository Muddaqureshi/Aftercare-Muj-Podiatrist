# Aftercare

**A little less to remember. A clearer view of every recovery.**

A code-first postoperative workflow demo designed for a podiatric surgeon: see who needs attention, keep your own treatment milestones organized, and review the week ahead.

**[Open Aftercare](https://muddaqureshi.github.io/Aftercare-Muj-Podiatrist/)**

## Try it

Six fictional cases load on your first visit, with dates relative to that day.

1. **Start with Overview.** “Needs attention” shows unrecorded past-due milestones and explicitly recorded no-shows. Those are different states: a past target date does not prove someone missed an appointment.
2. **Open a case.** Review the timeline, confirm completion, reschedule one milestone, or use the three-dot menu to log your own outreach attempt, record a confirmed no-show, or cancel a milestone. Changes preserve a local activity history; other dates do not move automatically.
3. **Add a case.** Enter a fictional code, procedure, side, and surgery date. Write your own milestones, for example `Day 7: My planned review` and `Week 6: My next review`. Preview the calculated dates before confirming.
4. **Ask Aftercare.** Try “What needs attention?”, “What is due today?”, “What is coming next week?”, or “Show DEMO-014”. To stage a new plan: `Plan DEMO-042 on 2026-09-19: Day 7: My planned review; Week 3: My next review`. Nothing is saved until you review and confirm.
5. **Open Weekly brief.** Navigate weeks, print a brief, or download open milestones as an all-day calendar file. Earlier unresolved milestones remain visible. Calendar downloads are snapshots, not live subscriptions; repeated imports can duplicate events.

Keyboard: **Cmd/Ctrl + K** opens the assistant. **Escape** closes a dialog. In the assistant, **Enter** sends and **Shift + Enter** adds a line break.

The assistant is **local and rule-based, not a connected AI model**. Unsupported wording gets examples rather than a guessed answer. It does not generate treatment protocols or change outcomes by chat. All fictional timing examples are interface demonstrations, **not clinical recommendations**.

## Important boundaries

This public demo is **not for real patient records** and is not represented as HIPAA-compliant.

- A patient code and omitted birthdate do not automatically make a record de-identified. Exact treatment dates and a re-identifiable code can still be protected health information. Clinical use needs a suitable deployment and professional de-identification/compliance review.
- Demo records stay in **this browser profile's local storage**. The site does not send them to GitHub, an AI service, an analytics platform, or a backend. Public source code contains only fictional fixtures. GitHub still serves the site itself and receives normal page/asset requests.
- There is **no login, encryption layer, server backup, access control, cloud sync, or protected clinical audit system**. Other people using the same browser profile can access the data. GitHub Pages project sites under the same hostname share a browser origin; local storage is not isolated from other applications on that origin.
- Use **Export backup** to save fictional work and **Restore backup** to replace this browser's data. Backups are unencrypted JSON. **Reset demo** replaces local records with fresh fictional examples. Clearing browser data removes saved records.
- There is **no live appointment integration, attendance monitoring, scheduled notification, email, SMS, or outreach sending**. An outreach action only logs an attempt you made yourself. Lists refresh when the app is opened, focused, or the local date changes.
- Milestones are planned calendar dates, not booked visits. Weeks run Monday–Sunday in the browser's local calendar. Completed dates record the actual local day of confirmation. The app does not change weekends, holidays, or downstream milestones automatically.
- This is a workflow demonstration, not an emergency monitoring system or a clinical decision-making tool.

## Moving toward real clinical use

Keep the public demo separate. A production implementation would need a reviewed hosting arrangement, appropriate vendor agreements where required, authentication and role-based access, encryption, durable storage and backups, protected audit records, and a defined retention policy. Establish a valid de-identification approach if using genuinely de-identified records.

Connect to an approved appointment system before claiming to detect no-shows. Use an authorized backend scheduler and communication service for actual reminders. A real AI assistant would need a server-side integration with an appropriately reviewed provider—never a browser-embedded API key—and should propose structured changes for clinician confirmation rather than independently recommend or modify treatment.

## Development

No framework or build step. HTML, CSS, and JavaScript ES modules; native dialogs; locally drawn SVG icons; system fonts. No runtime third-party requests.

Requirements: Node.js 22+, npm, and Python 3.

```sh
npm ci
npm test
npx playwright install chromium
npm run test:browser
npm start
```

Open `http://127.0.0.1:4173`. Serve the folder over HTTP; do not open `index.html` using a `file:` URL.

`domain.js` holds calendar arithmetic, status changes, parsing, backup validation, and calendar export. `app.js` renders the interface and commits validated changes to local storage. Plain `YYYY-MM-DD` strings and UTC-noon arithmetic avoid UTC/local and daylight-saving date shifts.

The workflow runs unit and Chromium desktop/mobile browser checks, then publishes only the static application files to GitHub Pages. Enable **Settings → Pages → Source: GitHub Actions** when deploying a fork.
