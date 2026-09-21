import { mkdir, copyFile, readFile, writeFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
await rm(resolve(root, "cloud/public/password-auth.js"), { force: true });
const files = ["domain.js", "csv.js", "styles.css", "tokens.css", "favicon.svg", "pilot/client.js", "pilot/pilot.css"];
for (const file of files) {
  const target = resolve(root, "cloud/public", file);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(resolve(root, file), target);
}
const html = (await readFile(resolve(root, "pilot/index.html"), "utf8"))
  .replace("Connected local pilot", "Hosted fictional pilot")
  .replace("<body>", '<body data-deployment="cloud">')
  .replace("Opening your local workspace", "Opening your online workspace")
  .replace("This local pilot requires", "This fictional pilot requires");
await writeFile(resolve(root, "cloud/public/index.html"), html);
console.log("Built the explicit public asset allowlist. No records, credentials, or server files were copied.");
