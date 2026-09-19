# Setup and operating guide

## Everyday use

1. Open **https://aftercare-muj-podiatrist.muddq-finances.workers.dev** on your phone or computer.
2. Enter the configured owner's Gmail address and select **Send sign-in code**. Enter the code from Gmail. Do not send the code to another person or an AI chat.
3. Add an invented case and your own milestones. Review the dates, then confirm saving.
4. Record each visit's outcome. Mark a no-show only after checking attendance.
5. Ask **AI assistant**, for example, "Who needs my attention this week?"
6. Use **Reminders & storage** to choose the daily Massachusetts-time reminder and inspect delivery status.

The hosted workspace starts empty. **Load six fictional examples** is available in an empty workspace and requires confirmation. It does not import anything from your Mac.

The default reminder time is **09:00 America/New_York**. The scheduler checks every 15 minutes, so a time between checks runs at the next eligible check. No due or overdue work results in a skipped run, not an email. Your Mac can be switched off.

## Existing deployment

| Item | Location |
|---|---|
| Online app | `https://aftercare-muj-podiatrist.muddq-finances.workers.dev` |
| Worker | `aftercare-muj-podiatrist` |
| D1 database | `aftercare-fictional` |
| Hosted configuration | `wrangler.jsonc` |
| Public demonstration | GitHub Pages for this repository |
| Local Mac app | `http://127.0.0.1:4317`, when running |

Resource names and the database ID in configuration are not authentication credentials. Cloudflare authorization is managed by Wrangler outside the repository.

## Deploy source changes

Requires Node.js 22.13 or later; use a currently supported Node 22+ release for the installed Wrangler version.

```sh
npm ci
npx wrangler login
npm test
npm run test:pilot
npm run test:cloud
npm run cloud:assets
npx wrangler deploy --dry-run
npm run cloud:deploy
```

Before changing the database schema, add a new numbered migration under `cloud/migrations/`; do not edit an already-applied migration:

```sh
npx wrangler d1 migrations apply aftercare-fictional --remote
```

Review database changes and recovery options before applying them.

**A GitHub push does not redeploy Cloudflare.** GitHub Actions checks the code and deploys only the public static demo. Use the explicit hosted deployment command above.

Do not widen either deployment's static-file allowlist to include the repository root, `.env`, `.data`, or server files.

## Fresh deployment in another account

1. Create a free Cloudflare account and a free `workers.dev` subdomain. No purchased domain is required.
2. Run `npm ci` and `npx wrangler login`.
3. Run `npx wrangler d1 create aftercare-fictional`.
4. Update `wrangler.jsonc` with that account's database ID, worker name, and exact HTTPS `APP_ORIGIN`.
5. Apply the schema migration and deploy using the commands above.
6. Configure the two secrets below using private prompts.
7. Verify owner sign-in, saving from two devices, hosted AI, and actual inbox delivery.

The app fails closed until its owner and exact origin are configured. Never enable a paid upgrade merely to work around a free-tier error without the account owner's approval.

## Gmail secrets and rotation

Two Cloudflare secrets are required:

- `GMAIL_ADDRESS`: the single owner's full Gmail address.
- `GMAIL_APP_PASSWORD`: a Google app password for that same account, not its normal password.

Set or replace them privately:

```sh
npx wrangler secret put GMAIL_ADDRESS
npx wrangler secret put GMAIL_APP_PASSWORD
```

Do not put their values in command arguments, screenshots, issue comments, chat, source, or GitHub Actions logs. The deployed frontend never receives the app password. Do not display Wrangler's authentication token in shared terminal output.

After rotating a Gmail app password, update the Cloudflare secret and verify sign-in email delivery. The old Mac pilot has a separate private `.env` copy; update it separately if you still use local email features. Revoking a password without updating the hosted secret prevents both sign-in codes and reminders from sending.

If SMTP authentication fails, verify the Google account matches the sender and the app password was copied correctly. Do not disable TLS verification or switch to an unencrypted transport.

## Check scheduled work

The Cloudflare dashboard shows the Worker's cron trigger. It should remain:

```text
*/15 * * * *
```

The trigger runs in UTC; application code converts each run to Massachusetts time, including daylight saving changes.

To inspect recent run outcomes without displaying recipient addresses or message bodies:

```sh
npx wrangler d1 execute aftercare-fictional --remote \
  --command "SELECT run_key,status,created_at,finished_at FROM reminders ORDER BY created_at DESC LIMIT 10"
```

| Status | Meaning |
|---|---|
| `accepted` | Gmail accepted the email; check the inbox separately |
| `skipped` | No due or overdue work |
| `sending` | A delivery attempt is in progress |
| `uncertain` | Delivery was not confirmed; inspect Gmail before requesting another test |

One daily ledger entry prevents duplicate scheduled sends, including after a deployment. Previously missed days are not replayed. Test emails have separate keys and are rate-limited.

To stop daily emails, turn off **Enable one daily reminder** in the hosted app. Retention cleanup still runs. Removing the Cloudflare cron trigger stops both scheduled reminders and automatic cleanup.

The old local pilot's daily reminder setting is disabled to prevent duplicates; restarting that local server does not automatically re-enable it.

## Retention, backup, and recovery

Open cases are never deleted merely because their surgery date is old. Closed cases are removed after 30 days in the closed state; reopening resets that clock. The timeline shows the scheduled removal date for a closed case.

D1 has provider-managed recovery history. Deleting a row from the active database does not immediately erase every recovery copy. Consult [Cloudflare's current Time Travel documentation](https://developers.cloudflare.com/d1/reference/time-travel/) for the applicable recovery window.

For a private manual export:

```sh
mkdir -p .data
chmod 700 .data
npx wrangler d1 export aftercare-fictional --remote --output .data/hosted-backup.sql
chmod 600 .data/hosted-backup.sql
```

This export is sensitive and unencrypted. It includes database state such as session hashes; keep it private, set a deletion policy, and never commit or email it. The automatic case-retention job does not delete downloaded backups.

A restore can overwrite newer work and bring back previously deleted cases. Review the snapshot, preserve a current recovery copy, and obtain explicit approval before restoring. Confirm the retention job and session state afterward.

## Validation commands

```sh
npm test
npm run test:pilot
npm run test:cloud
npm run test:browser
npm run test:pilot:browser
```

Browser tests require Playwright's Chromium and WebKit installations. The public and local browser suites use fictional fixtures. The local AI check, `npm run test:pilot:ai`, requires Ollama.

For an owner-authorized check of the actual hosted app:

```sh
CLOUDFLARE_ACCOUNT_ID=your_account_id node cloud/verify-live.js
```

This consumes some free AI allowance and sends one test reminder. It creates a short-lived test session through the owner's authenticated Cloudflare administration access, adds one uniquely named invented case, and removes that case and session afterward. It does not add a public authentication bypass or copy the local database.

## Troubleshooting

- **Wrong site:** the GitHub Page is still a separate rule-based demo. Use the hosted URL for online AI and private saving.
- **No sign-in email:** check the configured owner address and spam folder. Wait for the rate limit rather than repeatedly clicking send. Use the newest code; requesting another invalidates the previous one.
- **AI unavailable:** check the free quota and the configured model's current availability. Do not silently label a fallback as AI or enable billing. Manual plan entry remains available.
- **Conflict while saving:** refresh and review the newest record before retrying. Never force an old browser snapshot over newer data.
- **A change is missing on another device:** use **Refresh shared records**. The app saves centrally but does not push live updates into other open tabs.
- **Reminder unavailable:** inspect the delivery ledger and Cloudflare job status. Do not assume silence means there is no outstanding work.
- **Deleted case reappears after recovery:** inspect restore history and closure metadata; backups have a separate lifecycle.

This prototype is not an approved destination for actual patient records or a substitute for an EHR, clinical monitoring, or the practice's compliance review.
