import { test, expect } from "@playwright/test";
import { makeSeed } from "../domain.js";
import { patientsToCSV } from "../csv.js";

test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: new Date("2026-09-19T12:00:00-04:00") });
  await page.route("**/data/cases.csv", route => route.fulfill({ contentType: "text/csv", body: patientsToCSV(makeSeed("2026-09-19")) }));
  await page.goto("/");
});

test("published CSV can be loaded explicitly without silently overwriting browser work", async ({ page }) => {
  await page.getByRole("button", { name: "Mark DEMO-014: Wound review complete", exact: true }).click();
  await expect(page.locator(".attention-stat .stat-number")).toContainText("1");
  await page.locator("footer").getByRole("button", { name: "Load published cases" }).click();
  await page.locator("#confirm-dialog").getByRole("button", { name: "Go back" }).click();
  await expect(page.locator(".attention-stat .stat-number")).toContainText("1");
  await page.locator("footer").getByRole("button", { name: "Load published cases" }).click();
  await page.locator("#confirm-dialog").getByRole("button", { name: "Load published cases" }).click();
  await expect(page.locator(".attention-stat .stat-number")).toContainText("2");
});

test("overview is usable without external requests, errors, or horizontal overflow", async ({ page }, testInfo) => {
  const errors = [];
  const external = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => { if (!request.url().startsWith("http://127.0.0.1:4173")) external.push(request.url()); });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Your postoperative follow-ups." })).toBeVisible();
  await expect(page.locator(".attention-stat .stat-number")).toContainText("2");
  await expect(page.locator(".attention-panel .task-row")).toHaveCount(2);
  await expect(page.getByText("Local demo assistant · no AI model connected")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  await page.screenshot({ path: testInfo.outputPath("overview.png"), fullPage: true });
  expect(errors).toEqual([]);
  expect(external).toEqual([]);
});

test("search, one-tap completion, persistent undo, and reload work end to end", async ({ page }) => {
  await page.getByRole("button", { name: "Patients", exact: true }).click();
  await page.getByRole("searchbox").fill("DEMO-014");
  await expect(page.locator(".patient-row")).toHaveCount(1);
  await page.locator(".patient-row").click();
  await expect(page.getByRole("heading", { name: "DEMO-014", exact: true })).toBeVisible();
  await page.locator(".timeline-item.missed").getByRole("button", { name: "Mark complete", exact: true }).click();
  await expect(page.locator("#confirm-dialog")).not.toBeVisible();
  await page.locator("#patient-dialog").getByRole("button", { name: "Undo completion" }).click();
  await expect(page.locator(".timeline-item.missed")).toHaveCount(1);
  await page.locator(".timeline-item.missed").getByRole("button", { name: "Mark complete", exact: true }).click();
  await expect(page.locator("#confirm-dialog")).not.toBeVisible();
  await expect(page.locator(".timeline-item.missed")).toHaveCount(0);
  await page.getByRole("button", { name: "Close patient" }).click();
  await page.reload();
  await expect(page.locator(".attention-stat .stat-number")).toContainText("1");
  await page.getByRole("button", { name: "Patients", exact: true }).click();
  await page.getByRole("searchbox").fill("DEMO-014");
  await page.locator(".patient-row").click();
  await page.locator("#patient-dialog").getByRole("button", { name: "Undo completion" }).click();
  await expect(page.locator(".timeline-item.missed")).toHaveCount(1);
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
  await page.locator(".attention-panel .task-open").filter({ hasText: "DEMO-014" }).click();
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
  await page.locator(".attention-panel .task-open").filter({ hasText: "DEMO-023" }).click();
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

test("overview completion takes one tap, updates counts, and can be undone without opening a case", async ({ page }) => {
  const mark = page.getByRole("button", { name: "Mark DEMO-014: Wound review complete", exact: true });
  await mark.click();
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await expect(page.locator(".attention-stat .stat-number")).toContainText("1");
  await expect(page.locator(".stats-grid .stat-card").last()).toContainText("4");
  await expect(page.locator(".completion-notice")).toContainText("DEMO-014");
  await page.clock.fastForward(60000);
  await page.locator(".completion-notice").getByRole("button", { name: "Undo completion" }).click();
  await expect(page.locator(".attention-stat .stat-number")).toContainText("2");
  await expect(mark).toBeFocused();
  await expect(page.locator(".attention-panel .task-row").filter({ hasText: "DEMO-014" })).toContainText("Confirmed no-show");
});

test("completion failure does not remove a task or display a saved update", async ({ page }) => {
  await page.evaluate(() => {
    Storage.prototype.setItem = () => { throw new DOMException("Storage full", "QuotaExceededError"); };
  });
  await page.getByRole("button", { name: "Mark DEMO-014: Wound review complete", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("NOT saved");
  await expect(page.locator(".attention-stat .stat-number")).toContainText("2");
  await expect(page.locator(".completion-notice")).toHaveCount(0);
  await page.locator(".attention-panel .task-open").filter({ hasText: "DEMO-014" }).click();
  await page.locator(".timeline-item.missed").getByRole("button", { name: "Mark complete" }).click();
  await expect(page.locator("#patient-dialog").getByRole("alert")).toContainText("NOT saved");
  await expect(page.locator(".timeline-item.missed")).toHaveCount(1);
});

test("weekly counts distinguish open and completed items using the same planned dates as overview", async ({ page }) => {
  await expect(page.locator(".stats-grid .stat-card").nth(1)).toContainText("Due today–Sunday");
  await expect(page.locator(".stats-grid .stat-card").last()).toContainText("3");
  await page.getByRole("button", { name: "Weekly brief", exact: true }).click();
  await expect(page.locator(".week-summary")).toContainText("3 still open");
  await expect(page.locator(".week-summary")).toContainText("3 completed");
  await page.getByRole("button", { name: "Mark DEMO-023: Cast & recovery review complete", exact: true }).click();
  await expect(page.locator(".week-summary")).toContainText("2 still open");
  await expect(page.locator(".week-summary")).toContainText("4 completed");
});

async function expectNoClippedText(page) {
  const problems = await page.evaluate(() => {
    const problems = [];
    if (document.documentElement.scrollWidth > innerWidth + 1) problems.push("Page scrolls horizontally");
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (!node.textContent.trim()) continue;
      const element = node.parentElement;
      if (element.closest(".sr-only, .skip-link, script, style, option, textarea")) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) {
        if (!rect.width || !rect.height) continue;
        const description = `${element.tagName}.${element.className}: ${node.textContent.trim().slice(0, 60)}`;
        if (rect.left < -2 || rect.right > innerWidth + 2) {
          problems.push(`Outside viewport: ${description}`);
          break;
        }
        for (let parent = element; parent; parent = parent.parentElement) {
          const style = getComputedStyle(parent);
          const bounds = parent.getBoundingClientRect();
          if (["hidden", "clip", "auto", "scroll"].includes(style.overflowX) && (rect.left < bounds.left - 2 || rect.right > bounds.right + 2)) {
            problems.push(`Horizontally clipped: ${description}`);
            break;
          }
          if (["hidden", "clip"].includes(style.overflowY) && (rect.top < bounds.top - 2 || rect.bottom > bounds.bottom + 2)) {
            problems.push(`Vertically clipped: ${description}`);
            break;
          }
        }
      }
    }
    return [...new Set(problems)];
  });
  expect(problems).toEqual([]);
}

test("navigation, counts, lists, forms, and dialogs stay readable from small phones to desktop", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "This test explicitly covers its own viewport matrix.");
  for (const width of [320, 360, 390, 430, 768, 960, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    for (const label of ["Overview", "Patients", "Weekly brief"]) {
      const navLabel = page.locator(".nav-label").filter({ hasText: label });
      await expect(navLabel).toBeVisible();
      expect(await navLabel.evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(14);
    }
    expect(await page.locator(".task-person strong").first().evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
    const target = await page.locator(".task-footer button").first().boundingBox();
    expect(target.height).toBeGreaterThanOrEqual(44);
    await expectNoClippedText(page);
    if (width === 390 || width === 1440) await page.screenshot({ path: testInfo.outputPath(`updated-${width}.png`), fullPage: true });
    await page.getByRole("button", { name: "Patients", exact: true }).click();
    await expectNoClippedText(page);
    await page.getByRole("button", { name: "Weekly brief", exact: true }).click();
    await expectNoClippedText(page);
    await page.locator(".task-open").first().click();
    await expectNoClippedText(page);
    await page.locator("#patient-dialog").getByRole("button", { name: "Reschedule", exact: true }).first().click();
    await expectNoClippedText(page);
    await page.getByRole("button", { name: "Go back", exact: true }).click();
    await page.getByRole("button", { name: "Close patient" }).click();
    await page.locator(".assistant-top").click();
    await page.locator(".assistant-suggestions").getByRole("button", { name: "Needs attention" }).click();
    await expectNoClippedText(page);
    await page.getByRole("button", { name: "Close assistant" }).click();
    await page.locator(".nav-item[data-view='overview']").click();
    await page.getByRole("button", { name: "Add a case" }).click();
    await expectNoClippedText(page);
    await page.getByRole("button", { name: "Close new case" }).click();
  }
});

test("maximum-length codes and milestones wrap without truncation on a narrow phone", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  const code = "DEMO-1234567890123456";
  const label = "Postoperative".repeat(7) + "followups";
  await page.getByRole("button", { name: "Add a case" }).click();
  await page.getByLabel("Sample patient code").fill(code);
  await page.getByLabel("Your postoperative milestones").fill(`Day 0: ${label}`);
  await page.getByRole("button", { name: "Preview timeline" }).click();
  await expectNoClippedText(page);
  await page.getByRole("button", { name: "Confirm & add case" }).click();
  await expectNoClippedText(page);
  await expect(page.locator("#patient-dialog").getByRole("heading", { name: label, exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close patient" }).click();
  await page.getByRole("button", { name: "Patients", exact: true }).click();
  await expectNoClippedText(page);
  await page.getByRole("button", { name: "Weekly brief", exact: true }).click();
  await expectNoClippedText(page);
});
