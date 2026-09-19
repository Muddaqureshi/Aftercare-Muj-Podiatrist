import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { passwordProof, proofVerifier } from "../password-auth.js";

process.chdir(fileURLToPath(new URL("../", import.meta.url)));
const config = JSON.parse(readFileSync("wrangler.jsonc", "utf8"));
let phase = "private credential entry";

function dialog(message, initial = "", hidden = false) {
  const script = `text returned of (display dialog ${JSON.stringify(message)} default answer ${JSON.stringify(initial)} with title "Aftercare private sign-in setup" ${hidden ? "with hidden answer" : ""} buttons {"Cancel", "Continue"} default button "Continue" cancel button "Cancel")`;
  return execFileSync("osascript", ["-e", "activate", "-e", script], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).replace(/\r?\n$/, "");
}

try {
  if (process.platform !== "darwin") throw new Error("This private dialog helper requires macOS.");
  const username = dialog("Choose your Aftercare username: 3-40 letters, numbers, dots, hyphens, or underscores; start with a letter.", "surgeon").trim().toLowerCase();
  if (!/^[a-z][a-z0-9._-]{2,39}$/.test(username)) {
    console.error("Username format is invalid. Nothing was changed.");
    process.exit(1);
  }
  const password = dialog("Choose your Aftercare password (12-128 characters). This is NOT your Gmail app password. It will not be shown in chat or saved to a file.", "", true);
  if (password.length < 12 || password.length > 128) {
    console.error("Use a password of 12-128 characters. Nothing was changed.");
    process.exit(1);
  }
  if (password !== dialog("Enter that same Aftercare password again to confirm.", "", true)) {
    console.error("The passwords did not match. Nothing was changed.");
    process.exit(1);
  }
  const salt = randomBytes(32).toString("hex");
  const proof = await passwordProof(password, salt);
  const profile = { version: 1, username, salt, verifier: await proofVerifier(proof) };
  phase = "private Cloudflare configuration";
  execFileSync("./node_modules/.bin/wrangler", ["secret", "put", "OWNER_LOGIN"], {
    input: JSON.stringify(profile), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"]
  });
  console.log("Username and password verifier stored privately in Cloudflare. No plaintext password was saved.");
  phase = "deployment";
  execFileSync("npm", ["run", "cloud:deploy"], { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 5 * 1024 * 1024 });
  phase = "old-session revocation";
  execFileSync("./node_modules/.bin/wrangler", ["d1", "execute", config.d1_databases[0].database_name, "--remote", "--command", "DELETE FROM sessions; DELETE FROM login_challenge;"], { stdio: ["ignore", "pipe", "pipe"] });
  console.log("Password sign-in deployed. Previous sessions and obsolete email codes were revoked; case records were not changed.");
  phase = "live password sign-in verification";
  const { chromium, webkit } = await import("@playwright/test");
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch();
    try {
      const page = await browser.newPage({ viewport: { width: engine === webkit ? 375 : 1280, height: 900 } });
      await page.goto(config.vars.APP_ORIGIN);
      await page.getByLabel("Username", { exact: true }).fill(username);
      await page.getByLabel("Password", { exact: true }).fill(password);
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await page.getByRole("heading", { name: "Your postoperative follow-ups." }).waitFor();
      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error("Layout overflow.");
      const response = await page.request.get(`${config.vars.APP_ORIGIN}/api/state`);
      if (!response.ok()) throw new Error("Authenticated records are unavailable.");
      const state = await response.json();
      if (state.mailMode !== "smtp") throw new Error("Reminder delivery configuration changed.");
      await page.getByRole("button", { name: "Sign out", exact: true }).click();
      await page.getByRole("button", { name: "Sign in", exact: true }).waitFor();
    } finally { await browser.close(); }
  }
  console.log("Real username/password sign-in and sign-out verified on desktop and phone-sized Safari. No sign-in emails were needed.");
} catch {
  console.error(`Setup stopped during ${phase}. Credentials were not printed. If configuration had already completed, keep the chosen password and retry verification rather than assuming it was not saved.`);
  process.exitCode = 1;
}
