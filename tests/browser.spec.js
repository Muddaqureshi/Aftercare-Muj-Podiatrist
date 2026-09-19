import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: new Date("2026-09-19T12:00:00-04:00") });
  await page.goto("/");
});

test("overview is usable without external requests, errors, or horizontal overflow", async ({ page }, testInfo) => {
  const errors = [];
  const external = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => { if (!request.url().startsWith("http://127.0.0.1:4173")) external.push(request.url()); });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Your week, in good hands." })).toBeVisible();
  await expect(page.locator(".attention-stat .stat-number")).toContainText("2");
  await expect(page.locator(".attention-panel .task-row")).toHaveCount(2);
  await expect(page.getByText("Local demo assistant · no AI model connected")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  await page.screenshot({ path: testInfo.outputPath("overview.png"), fullPage: true });
  expect(errors).toEqual([]);
  expect(external).toEqual([]);
});

test("search, completion confirmation, and persistence work end to end", async ({ page }) => {
  await page.getByRole("button", { name: "Patients", exact: true }).click();
  await page.getByRole("searchbox").fill("DEMO-014");
  await expect(page.locator(".patient-row")).toHaveCount(1);
  await page.locator(".patient-row").click();
  await expect(page.getByRole("heading", { name: "DEMO-014", exact: true })).toBeVisible();
  await page.locator(".timeline-item.missed").getByRole("button", { name: "Complete", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Mark this milestone complete?" })).toBeVisible();
  await page.getByRole("button", { name: "Go back", exact: true }).click();
  await expect(page.locator(".timeline-item.missed")).toHaveCount(1);
  await page.locator(".timeline-item.missed").getByRole("button", { name: "Complete", exact: true }).click();
  await page.getByRole("button", { name: "Mark complete", exact: true }).click();
  await expect(page.locator("#confirm-dialog")).not.toBeVisible();
  await expect(page.locator(".timeline-item.missed")).toHaveCount(0);
  await page.getByRole("button", { name: "Close patient" }).click();
  await page.reload();
  await expect(page.locator(".attention-stat .stat-number")).toContainText("1");
});

test("create a case via explicit preview, reject duplicates, then find it", async ({ page }) => {
  await page.getByRole("button", { name: "Add a case" }).click();
  await page.getByLabel("Sample patient code").fill("DEMO-042");
  await page.getByLabel("Your postoperative milestones").fill("Day 7: My wound review\nWeek 6: My mobility review");
  await page.getByRole("button", { name: "Preview timeline" }).click();
  await expect(page.locator(".preview-list")).toContainText("Sep 26, 2026");
  await expect(page.locator(".preview-list")).toContainText("Oct 31, 2026");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("aftercare.demo.v1")).patients.length)).toBe(6);
  await page.getByRole("button", { name: "Confirm & add case" }).click();
  await expect(page.getByRole("heading", { name: "DEMO-042", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close patient" }).click();
  await page.getByRole("button", { name: "Add a case" }).click();
  await page.getByLabel("Sample patient code").fill("DEMO-042");
  await page.getByLabel("Your postoperative milestones").fill("Day 7: Review");
  await page.getByRole("button", { name: "Preview timeline" }).click();
  await expect(page.locator("#case-error")).toContainText("already exists");
});

test("rescheduling moves one milestone and preserves no-show history", async ({ page }) => {
  await page.locator(".attention-panel .task-row").filter({ hasText: "DEMO-014" }).click();
  await page.locator(".timeline-item.missed").getByRole("button", { name: "Reschedule" }).click();
  await page.getByLabel("New date").fill("2026-09-23");
  await page.getByRole("button", { name: "Save new date" }).click();
  await expect(page.locator("#confirm-dialog")).not.toBeVisible();
  const milestone = page.locator(".timeline-item").filter({ has: page.getByRole("heading", { name: "Wound review", exact: true }) });
  await expect(milestone).toContainText("Sep 23, 2026");
  await milestone.getByText("Activity history").click();
  await expect(milestone).toContainText("Rescheduled from Sep 15 to Sep 23");
  const data = await page.evaluate(() => JSON.parse(localStorage.getItem("aftercare.demo.v1")).patients.find(p => p.code === "DEMO-014"));
  expect(data.milestones[2].date).toBe("2026-09-29");
  expect(data.milestones[1].history.at(-1).previous.status).toBe("missed");
});

test("outreach and no-show actions stay explicit and never send anything", async ({ page }) => {
  await page.locator(".attention-panel .task-row").filter({ hasText: "DEMO-023" }).click();
  const overdue = page.locator(".timeline-item.overdue");
  await overdue.locator(".action-menu summary").click();
  await overdue.getByRole("button", { name: "Log outreach attempt" }).click();
  await page.getByRole("button", { name: "Log attempt", exact: true }).click();
  await expect(overdue).toContainText("No message was sent by Aftercare.");
  await overdue.locator(".action-menu summary").click();
  await overdue.getByRole("button", { name: "Record confirmed no-show" }).click();
  await page.getByRole("button", { name: "Record no-show", exact: true }).click();
  await expect(page.locator(".timeline-item.missed")).toHaveCount(1);
});

test("assistant answers current lists, refuses unsupported advice, and stages a plan", async ({ page }) => {
  await page.locator(".assistant-top").click();
  await page.locator(".assistant-suggestions").getByRole("button", { name: "Needs attention" }).click();
  await expect(page.locator("#messages")).toContainText("2 milestones need attention");
  await page.getByRole("textbox", { name: "Ask the demo assistant" }).fill("Which antibiotic should I use?");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.locator("#messages")).toContainText("I can’t infer a treatment plan");
  await page.getByRole("textbox", { name: "Ask the demo assistant" }).fill("Plan DEMO-077 on 2026-09-19: Day 7: My first review; Week 6: My next review");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.locator("#messages")).toContainText("Nothing has been saved");
  await page.getByRole("button", { name: "Review this plan" }).click();
  await expect(page.getByLabel("Sample patient code")).toHaveValue("DEMO-077");
  await expect(page.getByLabel("Your postoperative milestones")).toHaveValue("Day 7: My first review; Week 6: My next review");
});

test("weekly brief navigates and exports an actual calendar file", async ({ page }) => {
  await page.getByRole("button", { name: "Weekly brief", exact: true }).click();
  await expect(page.locator(".week-heading")).toContainText("Sep 14 – Sep 20, 2026");
  await page.getByRole("button", { name: "Next week", exact: true }).click();
  await expect(page.locator(".week-heading")).toContainText("Sep 21 – Sep 27, 2026");
  await page.getByRole("button", { name: "Calendar", exact: true }).click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download calendar", exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("aftercare-2026-09-21.ics");
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const content = Buffer.concat(chunks).toString();
  expect(content).toContain("BEGIN:VCALENDAR");
  expect(content).toContain("DTSTART;VALUE=DATE:20260922");
});

test("corrupt browser data produces a visible error, not silent data loss", async ({ page }) => {
  await page.evaluate(() => localStorage.setItem("aftercare.demo.v1", "{broken"));
  await page.reload();
  await expect(page.locator(".storage-error")).toContainText("Changes are disabled");
  expect(await page.evaluate(() => localStorage.getItem("aftercare.demo.v1"))).toBe("{broken");
  await page.locator("footer").getByRole("button", { name: "Reset demo", exact: true }).click();
  await page.locator("#confirm-dialog").getByRole("button", { name: "Reset demo", exact: true }).click();
  await expect(page.locator(".storage-error")).toHaveCount(0);
});

test("backups round-trip and invalid imports do not replace records", async ({ page }) => {
  const data = await page.evaluate(() => localStorage.getItem("aftercare.demo.v1"));
  await page.locator("#import-file").setInputFiles({ name: "invalid.json", mimeType: "application/json", buffer: Buffer.from('{"version":1,"patients":[{}]}') });
  await expect(page.getByRole("alert")).toContainText("Backup not restored");
  expect(await page.evaluate(() => localStorage.getItem("aftercare.demo.v1"))).toBe(data);
  await page.locator("#import-file").setInputFiles({ name: "valid.json", mimeType: "application/json", buffer: Buffer.from(data) });
  await page.getByRole("button", { name: "Replace & restore" }).click();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("aftercare.demo.v1")).patients.length)).toBe(6);
});

test("milestone content is treated as text, never executable markup", async ({ page }) => {
  await page.getByRole("button", { name: "Add a case" }).click();
  await page.getByLabel("Sample patient code").fill("DEMO-HTML");
  await page.getByLabel("Your postoperative milestones").fill('Day 7: <img src=x onerror=alert(1)>');
  await page.getByRole("button", { name: "Preview timeline" }).click();
  await expect(page.locator(".preview-list")).toContainText("<img src=x onerror=alert(1)>");
  await expect(page.locator(".preview-list img")).toHaveCount(0);
});
