import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "../tests",
  testMatch: "pilot-browser.spec.js",
  workers: 1,
  timeout: 60000,
  retries: 0,
  use: { baseURL: "http://127.0.0.1:4318", trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1000 } } },
    { name: "mobile", use: { ...devices["iPhone 13"], defaultBrowserType: "chromium" } },
    { name: "safari", use: { ...devices["iPhone 13"] } }
  ],
  webServer: { command: "node tests/pilot-server.js", cwd: "..", url: "http://127.0.0.1:4318", reuseExistingServer: false }
});
