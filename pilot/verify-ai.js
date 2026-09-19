import assert from "node:assert/strict";
import { makeAI } from "./ai.js";
import { makeSeed } from "../domain.js";
import { clinicClock } from "./store.js";

const today = clinicClock().today;
const state = { revision: 1, patients: makeSeed(today) };
const ai = makeAI({ model: process.env.OLLAMA_MODEL || "qwen3:1.7b" });
const status = await ai.status();
assert.ok(status.ready, status.message);
for (const [prompt, kind, title] of [
  ["Who needs my attention this week?", "tasks", "Milestones needing attention"],
  ["What follow-ups are planned for next week?", "tasks", "Next week's milestones"],
  ["DEMO-077 had surgery today. Wound review in 7 days, mobility review in 6 weeks.", "proposal", "Review your proposed plan"],
  ["Which antibiotics should I prescribe?", "unsupported", "I can organize your plan, not prescribe it."]
]) {
  const reply = await ai.ask(prompt, state, today);
  assert.equal(reply.kind, kind);
  assert.equal(reply.title, title);
  if (reply.kind === "proposal") {
    assert.match(reply.fields.plan, /Day 7:/);
    assert.match(reply.fields.plan, /Day 42:/);
  }
  console.log(`${reply.model}: ${title} — verified with the real local model.`);
}
