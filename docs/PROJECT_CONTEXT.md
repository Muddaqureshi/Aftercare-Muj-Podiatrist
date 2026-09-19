# Project context and implementation decisions

Last reviewed: September 19, 2026.

## Purpose

Aftercare is a single-surgeon postoperative follow-up assistant designed for a podiatric surgery workflow. The surgeon supplies the care plan, including follow-up visits and milestones such as a mobility review or physical therapy review. The app organizes those instructions and highlights outstanding updates.

The intended benefit is less manual tracking and a clearer view of follow-ups that need attention. Reduced missed visits, clinical outcomes, time savings, and financial return have not been measured.

The design priorities are plain language, readable text, visible navigation labels, phone-friendly layouts, no clipped labels, and few steps for routine updates.

## Scope and permissions

- All three versions are **fictional-data prototypes**.
- Patient codes and omitted birthdates do not establish de-identification. Exact treatment dates can still be identifying.
- No real patient records are approved for the public repository, public CSV, or current hosted deployment.
- The hosting target is one user, approximately 25 new cases per week, with free-tier services and no paid upgrades enabled by this implementation.
- Local Gmail credentials were copied into Cloudflare secrets with the owner's authorization. Their values are deliberately absent from this documentation.
- Local records were not automatically transferred to the hosted database.
- The requested retention rule is **30 days after every milestone is completed or cancelled**, not 30 days after surgery. Open and confirmed-no-show cases remain.

This document records product and engineering context, not a verbatim transcript or a clinical record.

## Three distinct versions

| Version | Purpose | Records | AI and reminders |
|---|---|---|---|
| GitHub Pages demo | Public, fictional demonstration | Starts from `data/cases.csv`; subsequent edits stay in that browser | Rule-based assistant; no server-side scheduler |
| Local Mac pilot | Local experimentation | `.data/aftercare.sqlite` | Local Ollama; local or Gmail reminders while the server runs |
| Hosted Cloudflare pilot | One signed-in online workspace | Private D1 database shared across the owner's devices | Workers AI and hosted Gmail reminder jobs |

The hosted app is the primary online experience:

**https://aftercare-muj-podiatrist.muddq-finances.workers.dev**

The GitHub Page remains a separate demo and links to the online app:

**https://muddaqureshi.github.io/Aftercare-Muj-Podiatrist/**

The public repository is **Muddaqureshi/Aftercare-Muj-Podiatrist**. It contains source, tests, configuration identifiers, documentation, and invented CSV fixtures, not hosted database records.

## Architecture

```text
Phone or computer
  -> HTTPS Cloudflare Worker
     -> signed-in API -> private D1 records
     -> Workers AI -> validated interpretation -> deterministic record queries
     -> Gmail over authenticated TLS -> owner's inbox

Cloudflare cron, every 15 minutes
  -> retention and expired-session cleanup
  -> Massachusetts-time reminder eligibility
  -> durable daily send ledger

GitHub repository
  -> Actions -> public static demo only
  -> explicit Wrangler deployment -> hosted Worker and allowlisted assets
```

### Key files

| Location | Responsibility |
|---|---|
| `domain.js` | Dates, cases, milestones, validation, and deterministic worklists |
| `backend-shared.js` | Shared error type, Massachusetts clock, and record mutations |
| `pilot/ai.js` | Shared interpretation/grounding checks and local Ollama transport |
| `pilot/client.js` | Shared local/hosted interface; deployment-aware messaging |
| `pilot/mailer.js` | SMTP transport reused by the local and hosted versions |
| `cloud/worker.js` | Hosted HTTP API, username/password sign-in, and scheduled entry point |
| `password-auth.js` | Shared password derivation and verifier comparison |
| `cloud/set-login.js` | Private owner credential setup/reset and live browser verification |
| `cloud/core.js` | D1 access, revision checks, sessions, rate limits, and retention |
| `cloud/services.js` | Workers AI and Workers-native Gmail TLS connection |
| `cloud/migrations/` | Versioned D1 schema |
| `cloud/build-assets.js` | Explicit static asset allowlist; excludes records and secrets |
| `cloud/verify-live.js` | Owner-authorized live verification and targeted cleanup |
| `wrangler.jsonc` | Worker, database binding, model, origin, and cron configuration |

## Important behavior

### Attendance and plans

- An overdue target means the outcome has not been recorded. It is never automatically a no-show.
- Record a confirmed no-show only after checking attendance.
- Completing, cancelling, or rescheduling one milestone does not move other dates.
- Logging outreach only records an attempt; it does not contact the patient.
- Stored revisions prevent stale browser changes from silently overwriting newer work.
- There is no EHR or appointment-system integration.

### AI

- The model interprets the submitted prompt. The whole case database is not sent to it.
- Worklists and counts are computed from saved records, not invented by the model.
- New plans require explicit user-supplied dates and timing. Proposed milestones must be grounded in exact quoted source text.
- Procedure and side are selected by the user rather than inferred.
- AI never saves a plan or changes attendance by itself. Review, edit, preview, and confirm are required.
- Requests for treatment recommendations receive a fixed unsupported response.
- Model or quota failures remain visible; no rule-based fallback is misrepresented as connected AI.
- The hosted model is `@cf/meta/llama-3.3-70b-instruct-fp8-fast`, within the free Workers AI allowance. The earlier Llama 3.1 binding resolved to a deprecated model, even though a direct REST request still worked.
- The local model remains `qwen3:1.7b`. Its structured schema avoids regex patterns that the local sampler could not compile.

### Sign-in and email

- Hosted sign-in uses the configured owner's username and password, with no email code or second factor. This supersedes the initial email-code design at the owner's request.
- Credential setup is private and administrator-authorized; no public account setup is exposed.
- Password derivation uses Web Crypto PBKDF2-SHA256 with 600,000 iterations and a random 32-byte salt. The expensive derivation runs in the browser to stay within the free Worker's CPU budget. The server stores only a SHA-256 verifier of the derived proof, never that reusable proof or the plaintext password.
- The public salt is not a credential. Treat the derived proof as password-equivalent: send it only over HTTPS, never log it, and never accept the stored verifier itself as a login proof.
- Login guesses are rate-limited by IP and globally. Password resets revoke existing sessions without changing records.
- Session cookies are Secure, HttpOnly, and SameSite=Strict. Only token hashes are stored; sessions expire after eight hours.
- There is no public registration, first-visitor setup, or hosted public-CSV publishing endpoint.
- Reminder emails contain aggregate counts and the sign-in link, not patient codes or treatment details.
- A durable daily key prevents duplicate scheduled sends. Uncertain delivery is not automatically retried.
- Gmail acceptance is not proof of inbox delivery. Hosted Gmail delivery was confirmed during initial setup; subsequent sign-ins no longer send any email.
- The hosted SMTP transport supplies a TLS socket resolved by the Workers runtime. Nodemailer's default Node DNS connection path failed in this runtime; TLS verification was not disabled.
- The Mac pilot's daily reminder setting was disabled at cutover to avoid duplicate emails. Its other features and records remain available.

### Retention

- The server records when a case first becomes fully completed or cancelled.
- A case stays until 30 Massachusetts calendar days have elapsed in that closed state.
- Reopening a milestone removes the closure date; closing it again starts a new clock.
- Unknown closure dates start a new clock instead of causing immediate deletion.
- Cleanup uses revision checks so it cannot erase a concurrent update that reopened a case.
- Deletion applies to the active hosted database. Provider recovery history, downloads, the local database, and public Git history have separate lifecycles.
- This retention policy is for a fictional tracker, not a substitute for medical-record retention obligations.

## Verification completed

Automated coverage includes date arithmetic, milestone actions, CSV handling, local persistence, hosted owner-only password sign-in, password derivation, rejection of stored-verifier replay, session expiry/rate limits, origin checks, stale-write conflicts, reminder deduplication, and retention boundaries.

The deployed app was also checked using actual D1 writes, the real hosted model, two browser engines, a phone-sized viewport, and a Gmail reminder send. Live-check records and its temporary session were removed afterward.

These are software checks, not clinical validation or a compliance certification.

## Remaining limits

- Manual attendance updates, not automatic appointment detection.
- No patient messaging, EHR connection, or clinical decision support.
- Free-provider limits and outages can interrupt service; this is not guaranteed monitoring.
- Refresh to see another device's latest changes; there is no real-time push sync.
- No automatic merge with the Mac pilot or browser-only public demo records.
- No production clinical approval, provider-agreement review, or complete clinical audit/recovery program.

See [OPERATIONS.md](OPERATIONS.md) for setup and maintenance.
