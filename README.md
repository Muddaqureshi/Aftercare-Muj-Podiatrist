# Aftercare

**Postoperative follow-ups, organized around your plan.**

Aftercare helps podiatric surgeons organize postoperative follow-ups in one place. Enter a patient code and your care milestones, then review what is due or overdue and record updates—designed to reduce manual tracking and the mental load between visits.

This is a fictional-data demo, not a clinical system. Time savings, fewer missed follow-ups, and financial return have not been measured.

**[Open the online AI app](https://aftercare-muj-podiatrist.muddq-finances.workers.dev)** · [Public fictional demo](https://muddaqureshi.github.io/Aftercare-Muj-Podiatrist/)

## Hosted fictional-data pilot

The hosted workspace is at **https://aftercare-muj-podiatrist.muddq-finances.workers.dev**. It is separate from the public GitHub Pages demo and the local Mac pilot. Private saving, cross-browser access, hosted AI, and Gmail sending have been verified live; this remains a fictional-data prototype, not a clinical system.

- **Private online storage:** the hosted interface saves to Cloudflare D1. The same signed-in workspace is available on your phone and computer; refresh to see another device's latest changes. Conflicting changes are rejected rather than overwritten. Nothing is saved into the public case CSV.
- **One owner:** sign in with the configured Gmail address and an eight-digit, single-use email code. Codes expire after ten minutes, guesses and sends are rate-limited, and sessions expire after eight hours. There is no public registration or first-visitor account claiming.
- **Hosted AI:** Workers AI interprets only the prompt you submit. Your entire database is not sent to the model. The same grounding checks and mandatory plan review as the local app apply. Free quota failures are explicit; manual entry remains available. No clinical recommendations are generated.
- **Gmail reminders:** a hosted job checks every 15 minutes, using Massachusetts time, and sends at most once per day when there is due or overdue work. Your Mac can be off. Messages contain aggregate counts, not case details. Accepted by Gmail is not proof of inbox delivery; uncertain sends are not retried automatically.
- **Confirmed retention rule:** keep all open cases. Remove a case from the active database after it has remained fully completed or cancelled for 30 calendar days. Reopening a milestone resets the clock. Unknown closure dates start a new clock rather than deleting an old case immediately. Provider recovery history, downloads, and the separate local/public demo copies are not purged by this rule.
- **No automatic local upload:** the hosted workspace starts empty. You can enter a fictional case or load six explicitly fictional examples under **Reminders & storage**.

For this migration, the old Mac pilot's daily reminder setting is disabled to avoid duplicate emails. Its records, manual test-email action, and local AI remain available.

### Free-tier deployment

This uses Workers, D1, Workers AI, and a cron trigger on the account's free plan. No paid upgrade is enabled by the deployment commands. Free quotas, service outages, and email-provider limits can interrupt service; this is not a guaranteed monitoring system.

For a new installation, change the worker name, D1 database ID, and `APP_ORIGIN` in `wrangler.jsonc` to your own resources:

```sh
npm ci
npx wrangler login
npx wrangler d1 create aftercare-fictional
# Update wrangler.jsonc with the new database ID and your workers.dev address.
npx wrangler d1 migrations apply aftercare-fictional --remote
npm run cloud:deploy
npx wrangler secret put GMAIL_ADDRESS
npx wrangler secret put GMAIL_APP_PASSWORD
```

Enter the Gmail address and its Google app password only into the private Wrangler prompts. They are stored as Cloudflare secrets, not in GitHub or browser assets. `APP_ORIGIN` must exactly match the HTTPS deployment address. The app fails closed until the owner and address are configured. TLS certificate verification stays enabled; the hosted transport uses Workers-native hostname resolution for Gmail.

Source pushes update the **public demo** through GitHub Actions. Deploy the hosted app explicitly with `npm run cloud:deploy`; there is no Cloudflare deployment credential in the public repository.

```sh
npm run test:cloud
npm run cloud:assets
npx wrangler deploy --dry-run
# Optional live check: uses your authenticated Cloudflare CLI; sends one test email.
CLOUDFLARE_ACCOUNT_ID=your_account_id node cloud/verify-live.js
```

The live check creates a temporary, short-lived administrator-authorized session and one invented case, verifies real backend/model/browser behavior, then deletes only its own case and session. It does not upload your local database. It is not a public application endpoint.

**Actual patient data is not approved for this deployment.** Free hosting and patient codes do not establish HIPAA compliance or de-identification. A production clinical service requires an appropriate hosting/AI/email arrangement, access and recovery controls, operational monitoring, and review of the practice's record-retention obligations.

## Connected local pilot

The public link above is still a rule-based demo, now loading a **public fictional CSV snapshot** from [`data/cases.csv`](data/cases.csv). A **separate signed-in, single-surgeon pilot** runs on your Mac at **http://127.0.0.1:4317**. GitHub Pages cannot run its backend or write files by itself.

The pilot includes:

- **Real local AI:** Ollama with `qwen3:1.7b` interprets questions and drafts explicitly supplied plans. The server retrieves worklists directly from saved data; the model does not invent query results. Plan drafts must quote your timing, are checked against your words, and require clinician review and confirmation. You select the procedure and side; the AI does not choose them.
- **Durable working records:** SQLite on this Mac, accessible from your signed-in browser profiles. Revision checks reject conflicting updates rather than silently overwriting them.
- **Single-surgeon attendance workflow:** record completed milestones, confirmed no-shows, rescheduling, and your own outreach attempts. The interface does not require managing a team.
- **Public fictional CSV snapshots:** in **Reminders & storage**, download a case CSV or select **Publish fictional data**. Publishing requires explicit confirmation that every case is invented. The local server uses this Mac's authenticated GitHub CLI to commit `data/cases.csv`; no GitHub credential goes into browser code. Account names, passwords, and reminder addresses are excluded from the CSV.
- **Scheduled review reminders:** one daily run at the configured Massachusetts time. By default, messages go to a clearly labeled **local test inbox, not actual email**. Optional SMTP connects your email service. Emails include aggregate counts and a sign-in link—not patient codes, dates, or treatment details.

### Start and use the pilot

Requires Node.js **22.13+** and a recent Ollama installation. On this Mac, Ollama and the model were installed for the pilot.

Start the local AI engine in one terminal:

```sh
OLLAMA_HOST=127.0.0.1:11434 OLLAMA_NO_CLOUD=1 ollama serve
```

In another terminal:

```sh
cd Aftercare-Muj-Podiatrist
ollama pull qwen3:1.7b
npm ci
npm run pilot
```

The model download is needed only once. If Ollama is already running, do not start a second engine.

1. Open **http://127.0.0.1:4317** and create your own surgeon username/password. No default credentials are published. Six fictional cases are loaded.
2. Use **Overview** for overdue outcomes and this week's upcoming milestones. Open a case for attendance updates. Overdue is never automatically treated as a no-show.
3. Open **AI assistant**. Try “Who needs attention?” or “What follow-ups are planned for next week?” To draft a plan, try “DEMO-077 had surgery today. Wound review in 7 days, mobility review in 6 weeks.” Select **Review and edit draft**, choose the procedure and side, preview the dates, and confirm.
4. In **Reminders & storage**, choose a daily reminder time and select **Create test inbox message** to inspect a captured reminder.
5. To share invented cases through the public site, select **Publish fictional data**, confirm, and wait for the GitHub Pages deployment. On the public page select **Load published cases**. New browsers load that snapshot automatically; existing browser-only edits are not silently overwritten.

**Publication is a snapshot, not two-way cloud sync.** Edits on the public page remain in that browser and are not written back to the repository. The connected local pilot is the publishing tool. The CSV and its history are public; never publish real records, even with patient codes. Publication does not move the AI engine or scheduler onto GitHub Pages.

**Small-model limitations:** everyday wording is interpreted by a real model but not guaranteed to be understood correctly. Unsupported or ungrounded plans produce an explicit error; there is no pretend AI fallback. Ambiguous timing is not inferred. Check all drafts, and use the manual plan form whenever interpretation fails. AI chat cannot independently change attendance or other records.

### Actual email is optional and not connected by default

Copy `.env.example` to a private `.env` and configure your provider's SMTP host, port (465 or 587), user, app password, and sender address. Restart the pilot, enter your actual reminder address in **Reminders & storage**, and send a test. Never commit `.env` or paste credentials into an AI chat.

“Accepted by email server” is not a guarantee of inbox delivery. Failed or uncertain sends remain visible and are not automatically retried, to avoid duplicate emails. Inspect your inbox before sending another test.

The scheduler runs **only while the server is running and this Mac is awake**. Starting after today's configured time catches up once; it does not replay previous days. A persistent run ledger prevents the same daily reminder being sent twice after a restart. No open work results in a logged skipped run.

### Local pilot boundaries and storage

This is **still a fictional-data prototype, not a HIPAA-compliant clinical system**. Codes and omitted birthdates do not establish de-identification. These features do not change that.

- The server deliberately binds to **127.0.0.1 only**. It is not available from another computer or your phone. Phone-sized layouts are supported, but shared access from actual devices requires a separately reviewed deployment with HTTPS. Do not expose this prototype using a public tunnel.
- Working data, accounts, sessions, activity history, and reminder logs live in `.data/aftercare.sqlite`. `.data/` and `.env` are gitignored and are never served as web assets. Only explicitly published fictional cases go into `data/cases.csv`. The deployment publishes the static demo and that CSV—not the backend, credentials, or private database.
- Passwords are hashed; sessions use HttpOnly/SameSite cookies with an eight-hour expiry. Database files have owner-only file permissions, but there is **no application-level database encryption, protected clinical audit system, account-recovery workflow, automatic backup service, or production identity provider**.
- To back up fictional pilot work, stop the pilot cleanly and copy the private `.data` directory to a location you control. This is not a substitute for production backup/restore management. Do not publish the copy.
- There is no EHR connection, automatic attendance detection, patient email/SMS, or automatic two-way cloud sync. An outreach action records a contact attempt you made; it does not contact anyone.

Verification commands:

```sh
npm run test:pilot
npm run test:pilot:browser
npm run test:pilot:ai
```

Server tests cover shared sessions, permissions, conflict rejection, restart persistence, reminder timing and failures, and AI output grounding. Browser tests use an explicitly labeled AI test double; **`test:pilot:ai` connects to the real local model** and requires Ollama to be running. Automated tests do not constitute clinical validation.

## Try the public demo

The public fictional CSV snapshot loads on your first visit. **Reset demo** creates six fresh examples with dates relative to today; those reset examples stay in your browser unless separately published from the local pilot.

1. **Start with Overview.** “Needs attention” shows unrecorded past-due milestones and explicitly recorded no-shows. Those are different states: a past target date does not prove someone missed an appointment.
2. **Record an update.** Tap **Mark complete** directly on Overview or Weekly brief, without opening the case. **Undo completion** restores the previous status (including a no-show) without changing dates; it remains available in the timeline after a reload. Open a case to reschedule one milestone, or use **More** to log your own outreach attempt, record a confirmed no-show, or cancel a milestone. Those actions still require confirmation. Activity history is preserved.
3. **Add a case.** Enter a fictional code, procedure, side, and surgery date. Write your own milestones, for example `Day 7: My planned review` and `Week 6: My next review`. Preview the calculated dates before confirming.
4. **Ask Aftercare.** Try “What needs attention?”, “What is due today?”, “What is coming next week?”, or “Show DEMO-014”. To stage a new plan: `Plan DEMO-042 on 2026-09-19: Day 7: My planned review; Week 3: My next review`. Nothing is saved until you review and confirm.
5. **Open Weekly brief.** Navigate weeks, print a brief, or download open milestones as an all-day calendar file. Earlier unresolved milestones remain visible. Calendar downloads are snapshots, not live subscriptions; repeated imports can duplicate events.

**Reading the counts:** “Needs attention” includes overdue updates and confirmed no-shows from any date. “Due today–Sunday” includes open items with target dates from today through Sunday. “This week’s completed” and the Weekly brief completion count both refer to completed milestones whose **planned dates** fall in the selected Monday–Sunday week. Actual completion dates are recorded separately in the timeline. The brief explicitly separates still-open and completed items.

Navigation labels remain visible on phones and tablets. Lists and dialogs wrap long patient codes and milestone text; routine action targets are at least 44 pixels high.

Keyboard: **Cmd/Ctrl + K** opens the assistant. **Escape** closes a dialog. In the assistant, **Enter** sends and **Shift + Enter** adds a line break.

The assistant is **local and rule-based, not a connected AI model**. Unsupported wording gets examples rather than a guessed answer. It does not generate treatment protocols or change outcomes by chat. All fictional timing examples are interface demonstrations, **not clinical recommendations**.

## Important boundaries

This public demo is **not for real patient records** and is not represented as HIPAA-compliant.

- A patient code and omitted birthdate do not automatically make a record de-identified. Exact treatment dates and a re-identifiable code can still be protected health information. Clinical use needs a suitable deployment and professional de-identification/compliance review.
- The published fictional snapshot is **public in GitHub and Git history**. Edits made on the public page stay in **this browser profile's local storage**; this page does not upload them to GitHub, an AI service, an analytics platform, or a backend. The separate authenticated local pilot can publish a new fictional snapshot after confirmation.
- There is **no login, encryption layer, server backup, access control, cloud sync, or protected clinical audit system**. Other people using the same browser profile can access the data. GitHub Pages project sites under the same hostname share a browser origin; local storage is not isolated from other applications on that origin.
- Use **Export backup** to save fictional work and **Restore backup** to replace this browser's data. Backups are unencrypted JSON. **Reset demo** replaces local records with fresh fictional examples. Clearing browser data removes saved records.
- There is **no live appointment integration, attendance monitoring, scheduled notification, email, SMS, or outreach sending**. An outreach action only logs an attempt you made yourself. Lists refresh when the app is opened, focused, or the local date changes.
- Milestones are planned calendar dates, not booked visits. Weeks run Monday–Sunday in the browser's local calendar. Completed dates record the actual local day you tap **Mark complete**. The app does not change weekends, holidays, or downstream milestones automatically.
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
npx playwright install chromium webkit
npm run test:browser
npm start
```

Open `http://127.0.0.1:4173`. Serve the folder over HTTP; do not open `index.html` using a `file:` URL.

`domain.js` holds calendar arithmetic, status changes, parsing, backup validation, and calendar export. `app.js` renders the interface and commits validated changes to local storage. Plain `YYYY-MM-DD` strings and UTC-noon arithmetic avoid UTC/local and daylight-saving date shifts.

The workflow runs unit tests plus desktop/mobile Chromium and mobile WebKit (Safari engine) browser checks, then publishes only the static application files to GitHub Pages. Responsive checks cover 320–1440 pixel widths and maximum-length codes and milestone labels. Enable **Settings → Pages → Source: GitHub Actions** when deploying a fork.
