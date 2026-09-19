import { spawn } from "node:child_process";
import { patientsToCSV } from "../csv.js";
import { HttpError } from "./store.js";

const repository = "Muddaqureshi/Aftercare-Muj-Podiatrist";
const filePath = "data/cases.csv";

function github(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", args, { stdio: ["pipe", "pipe", "pipe"] });
    let output = "", error = "";
    const timeout = setTimeout(() => { child.kill("SIGTERM"); }, 30000);
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { error += chunk; });
    child.on("error", () => { clearTimeout(timeout); reject(new HttpError(503, "GitHub CLI is unavailable. Install gh and sign in locally; never add a token to the web page.")); });
    child.on("close", code => {
      clearTimeout(timeout);
      if (code !== 0) reject(new HttpError(502, `GitHub did not confirm publication. Check local gh authentication and retry after refreshing. ${error.includes("409") ? "The repository changed during publication." : ""}`));
      else resolve(output.trim());
    });
    child.stdin.on("error", () => { clearTimeout(timeout); reject(new HttpError(502, "The GitHub publication request could not be written. No publication was confirmed.")); });
    child.stdin.end(input || "");
  });
}

export function makePublisher({ run = github } = {}) {
  let busy = false;
  return {
    async publish(patients, revision) {
      if (busy) throw new HttpError(409, "Another snapshot is being published. Please wait.");
      busy = true;
      try {
        const sha = await run(["api", `repos/${repository}/contents/${filePath}`, "--jq", ".sha"]);
        if (!/^[a-f0-9]{40}$/.test(sha)) throw new HttpError(502, "The current GitHub snapshot could not be identified.");
        const payload = JSON.stringify({
          message: `Publish fictional Aftercare snapshot (local revision ${revision})`,
          content: Buffer.from(patientsToCSV(patients)).toString("base64"), sha, branch: "main"
        });
        const output = await run(["api", "--method", "PUT", `repos/${repository}/contents/${filePath}`, "--input", "-"], payload);
        const result = JSON.parse(output);
        if (!result.commit?.html_url) throw new HttpError(502, "GitHub did not return a confirmed snapshot commit.");
        return { revision, commitURL: result.commit.html_url, fileURL: `https://github.com/${repository}/blob/main/${filePath}`, pageURL: "https://muddaqureshi.github.io/Aftercare-Muj-Podiatrist/" };
      } finally { busy = false; }
    }
  };
}
