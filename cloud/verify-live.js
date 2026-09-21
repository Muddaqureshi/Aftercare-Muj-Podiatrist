import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import { chromium, webkit } from "@playwright/test";

// Cloudflare authorization is used only to clean up the uniquely named test case.
const config = JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
const origin = config.vars.APP_ORIGIN;
if (!/^https:\/\/[a-z0-9.-]+\.workers\.dev$/.test(origin)) throw Error("Set the deployed workers.dev origin before running the live check.");
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!/^[a-f0-9]{32}$/.test(account || "")) throw Error("Set CLOUDFLARE_ACCOUNT_ID to the account that owns the deployment.");
const auth = JSON.parse(execFileSync("./node_modules/.bin/wrangler", ["auth", "token", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
const endpoint = `https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${config.d1_databases[0].database_id}/query`;
async function query(sql, params = []) {
  const response = await fetch(endpoint, { method: "POST", headers: { Authorization: `Bearer ${auth.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ sql, params }) });
  const result = await response.json();
  if (!response.ok || !result.success) throw Error(`D1 verification request failed (${response.status}).`);
  return result.result[0];
}
const code = `VERIFY-${randomBytes(4).toString("hex").toUpperCase()}`;
async function api(path, body) {
  const response = await fetch(`${origin}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { Origin: origin, "X-Aftercare": "1", "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const result = await response.json();
  if (!response.ok) throw Error(`${path} failed (${response.status}): ${result.error || "No confirmation"}`);
  return result;
}
const browsers = [];
try {
  assert.equal((await api("/api/state")).accessMode, "public");
  const settings = await api("/api/settings");
  assert.equal(settings.settings.recipient, undefined);
  assert.equal(settings.reminders, undefined);
  for (const path of ["/api/login", "/api/logout", "/api/settings", "/api/reminders/test"]) {
    const result = await fetch(`${origin}${path}`, { method: "POST", headers: { Origin: origin, "X-Aftercare": "1", "Content-Type": "application/json" }, body: "{}" });
    assert.equal(result.status, 404);
  }
  for (const path of ["/.env", "/cloud/worker.js", "/data/cases.csv"]) assert.equal((await fetch(`${origin}${path}`)).status, 404);
  const browser = await chromium.launch();
  browsers.push(browser);
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(origin);
  await page.getByRole("button", { name: "Add a case", exact: true }).click();
  assert.equal(await page.locator("#auth-form").count(), 0);
  assert.equal(await page.locator(".pilot-shell > .pilot-notice, .pilot-shell > .pilot-footnote").count(), 0);
  assert.equal(await page.getByRole("button", { name: "Sign out", exact: true }).count(), 0);
  await page.getByLabel("Fictional patient code").fill(code);
  await page.getByLabel("Your milestones").fill("Day 7: Fictional review\nWeek 6: Fictional mobility review");
  await page.getByRole("button", { name: "Preview dates" }).click();
  await page.getByRole("button", { name: "Confirm & save shared plan" }).click();
  await page.locator("#case-dialog").waitFor({ state: "hidden" });
  let state = await api("/api/state");
  const patient = state.patients.find(p => p.code === code);
  assert.ok(patient);
  assert.equal(patient.milestones.length, 2);
  for (const milestone of patient.milestones) {
    state = await api("/api/actions", { revision: state.revision, action: "milestone", operation: "complete", patientId: patient.id, milestoneId: milestone.id });
  }
  assert.equal(state.closedSince[patient.id], state.today);
  state = await api("/api/actions", { revision: state.revision, action: "milestone", operation: "undo-complete", patientId: patient.id, milestoneId: patient.milestones[1].id });
  assert.equal(state.closedSince[patient.id], undefined);
  console.log("Live public saving, completion, and reopening verified without credentials.");

  for (const [prompt, kind] of [
    ["Who needs my attention this week?", "tasks"],
    ["What follow-ups are planned for next week?", "tasks"],
    ["DEMO-AICHECK had surgery today. Wound review in 7 days, mobility review in 6 weeks.", "proposal"],
    ["Which antibiotic should I prescribe?", "unsupported"]
  ]) {
    const result = await api("/api/assistant", { prompt });
    assert.equal(result.kind, kind);
    if (kind === "proposal") {
      assert.match(result.fields.plan, /Day 7:/);
      assert.match(result.fields.plan, /Day 42:/);
    }
    console.log(`Real hosted AI verified: ${kind}.`);
  }
  const safari = await webkit.launch();
  browsers.push(safari);
  const phone = await safari.newContext({ viewport: { width: 375, height: 812 } });
  const mobile = await phone.newPage();
  await mobile.goto(origin);
  await mobile.getByRole("button", { name: "Patients", exact: true }).click();
  await mobile.getByLabel("Find a case").fill(code);
  await mobile.getByRole("button", { name: new RegExp(code) }).waitFor();
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await mobile.getByRole("button", { name: "AI assistant", exact: true }).click();
  await mobile.getByRole("heading", { name: "Ask your online AI assistant." }).waitFor();
  assert.equal(await mobile.locator("#main .pilot-notice").count(), 0);
  await mobile.getByRole("button", { name: "Reminders & storage", exact: true }).click();
  await mobile.getByRole("heading", { name: "Shared records & automatic cleanup" }).waitFor();
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await mobile.getByRole("button", { name: "Publish fictional data" }).count(), 0);
  console.log("Same saved case verified in a second browser; phone layout does not overflow.");
  assert.equal(await mobile.getByRole("button", { name: "Send test email" }).count(), 0);
  assert.equal(await mobile.locator("#reminder-form").count(), 0);
  console.log("Public browsers cannot see email details, change settings, or send test emails.");
} finally {
  for (const browser of browsers) await browser.close();
  let cleaned = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = (await query("SELECT * FROM workspace WHERE id=1")).results[0];
    const patients = JSON.parse(row.patients), closed = JSON.parse(row.closed_since);
    const synthetic = patients.filter(p => p.code === code);
    for (const p of synthetic) delete closed[p.id];
    if (!synthetic.length) { cleaned = true; break; }
    const result = await query("UPDATE workspace SET patients=?,closed_since=?,revision=revision+1 WHERE id=1 AND revision=?", [JSON.stringify(patients.filter(p => p.code !== code)), JSON.stringify(closed), row.revision]);
    if (result.meta.changes === 1) { cleaned = true; break; }
  }
  if (!cleaned) throw Error("Live check finished, but its synthetic case needs manual cleanup because the workspace kept changing.");
  console.log("Temporary verification case removed; other records were not changed.");
}
