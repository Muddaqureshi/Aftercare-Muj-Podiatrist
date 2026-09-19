import { test, expect } from "@playwright/test";

const testPassword = "fictional-test-account-only";

test("signed-in pilot supports shared attendance, plan preview, AI queries, and reminder capture", async ({ page, browser }, testInfo) => {
  await page.goto("/");
  await page.getByLabel("Username", { exact: true }).fill("test-clinician");
  await page.getByLabel("Password", { exact: true }).fill(testPassword);
  await page.locator("#auth-form button").click();
  await expect(page.getByRole("heading", { name: "Your postoperative follow-ups." })).toBeVisible();
  await expect(page.getByText("Reminders go to the local test inbox", { exact: false })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: testInfo.outputPath("pilot-overview.png"), fullPage: true });
  await page.getByRole("button", { name: "Mark DEMO-014: Wound review complete", exact: true }).click();
  await page.locator(".completion-notice").getByRole("button", { name: "Undo completion" }).click();
  await expect(page.getByRole("button", { name: "Mark DEMO-014: Wound review complete", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Add a case", exact: true }).click();
  await page.getByLabel("Fictional patient code").fill(`TEST-${testInfo.project.name.toUpperCase()}`);
  await page.getByLabel("Your milestones").fill("Day 7: My own review\nWeek 6: My mobility review");
  await page.getByRole("button", { name: "Preview dates" }).click();
  await expect(page.getByRole("heading", { name: "Check every date" })).toBeVisible();
  expect(await page.locator(".preview-list > div").count()).toBe(2);
  await page.getByRole("button", { name: "Confirm & save shared plan" }).click();
  await expect(page.locator("#case-dialog")).not.toBeVisible();

  await page.getByRole("button", { name: "AI assistant", exact: true }).click();
  await page.getByLabel("Your question or plan").fill("Who needs attention?");
  await page.getByRole("button", { name: "Ask local AI", exact: true }).click();
  await expect(page.locator(".ai-response")).toContainText("DEMO-014");
  await expect(page.locator(".ai-response")).toContainText("TEST DOUBLE");

  await page.getByRole("button", { name: "Reminders & storage", exact: true }).click();
  await page.getByRole("button", { name: "Create test inbox message" }).click();
  await expect(page.locator(".mail-item").first()).toContainText("Local preview · not emailed");
  await page.locator(".mail-item").first().locator("summary").click();
  await expect(page.locator(".mail-item").first()).toContainText("LOCAL PREVIEW ONLY");
  await expect(page.getByRole("button", { name: "Create staff account" })).toHaveCount(0);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download case CSV" }).click();
  expect((await downloadPromise).suggestedFilename()).toContain("aftercare-fictional-");
  await page.getByRole("button", { name: "Publish fictional data" }).click();
  await page.getByRole("button", { name: "Confirm publication" }).click();
  await expect(page.locator("#confirm-dialog").getByRole("alert")).toContainText("Confirm that all cases are fictional");
  await page.getByLabel("Every case is invented and contains no real patient data.").check();
  await page.getByRole("button", { name: "Confirm publication" }).click();
  await expect(page.locator("#confirm-dialog")).not.toBeVisible();
  await expect(page.getByText(/Fictional snapshot revision .* committed to GitHub/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();

  const staffContext = await browser.newContext();
  const staff = await staffContext.newPage();
  try {
    await staff.goto("http://127.0.0.1:4318/");
    await staff.getByLabel("Username", { exact: true }).fill("test-clinician");
    await staff.getByLabel("Password", { exact: true }).fill(testPassword);
    await staff.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(staff.getByRole("button", { name: "Add a case" })).toBeVisible();
    await staff.getByRole("button", { name: "Mark DEMO-014: Wound review complete", exact: true }).click();
    await page.getByRole("button", { name: "Overview", exact: true }).click();
    await page.getByRole("button", { name: "Refresh shared records" }).click();
    await expect(page.getByRole("button", { name: "Mark DEMO-014: Wound review complete", exact: true })).toHaveCount(0);
    await staff.locator(".completion-notice").getByRole("button", { name: "Undo completion" }).click();
  } finally { await staffContext.close(); }
});
