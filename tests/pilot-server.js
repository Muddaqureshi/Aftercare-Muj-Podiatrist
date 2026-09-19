import { createPilot } from "../pilot/server.js";
import { resolveInterpretation } from "../pilot/ai.js";

// This explicit test double is never used by `npm run pilot`.
const ai = {
  async status() { return { ready: true, model: "TEST DOUBLE", message: "Browser fixture, not a real AI connection." }; },
  async ask(prompt, state, today) {
    const answer = resolveInterpretation({ intent: "attention" }, prompt, state, today);
    return { ...answer, model: "TEST DOUBLE" };
  }
};
const publisher = { async publish(_patients, revision) { return { revision, commitURL: "https://github.com/example/test-double" }; } };
const pilot = createPilot({ dbPath: ":memory:", ai, publisher, mailer: { mode: "local-inbox", async send() {} }, schedule: false });
await pilot.listen(4318);
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, async () => { await pilot.close(); process.exit(0); });
