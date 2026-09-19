import test from "node:test";
import assert from "node:assert/strict";
import { patientsToCSV, patientsFromCSV } from "../csv.js";
import { makeSeed } from "../domain.js";
import { makePublisher } from "../pilot/publish.js";

test("CSV preserves cases, dates, quoted labels, and history without account identities", () => {
  const patients = makeSeed("2026-09-19");
  patients[0].milestones[0].label = 'Review, "quoted"\nand multiline';
  patients[0].milestones[1].history[0].recordedBy = "private-login";
  patients[0].milestones[1].history[0].recordedAt = "2026-09-19T18:00:00Z";
  const csv = patientsToCSV(patients);
  assert.doesNotMatch(csv, /private-login|recordedAt/);
  const decoded = patientsFromCSV(csv);
  delete patients[0].milestones[1].history[0].recordedBy;
  delete patients[0].milestones[1].history[0].recordedAt;
  assert.deepEqual(decoded, patients);
});

test("CSV neutralizes spreadsheet formulas while preserving round-trip text", () => {
  for (const label of ["=1+1", "+SUM(A1)", "@command", "'literal", "-formula"]) {
    const patients = makeSeed("2026-09-19");
    patients[0].milestones[0].label = label;
    const csv = patientsToCSV(patients);
    assert.ok(csv.includes(`"'${label}"`));
    assert.equal(patientsFromCSV(csv)[0].milestones[0].label, label);
  }
});

test("malformed CSV and invalid records are rejected explicitly", () => {
  assert.throws(() => patientsFromCSV("not,a,case,csv"), /not an Aftercare/);
  assert.throws(() => patientsFromCSV('"unclosed'), /unclosed/);
  assert.throws(() => patientsFromCSV('"bad"trailing'), /Unexpected/);
  const csv = patientsToCSV(makeSeed("2026-09-19"));
  assert.throws(() => patientsFromCSV(csv.replaceAll("2026-09-01", "2026-02-30")), /invalid/i);
});

test("GitHub publishing uses an authenticated server-side snapshot commit, never account credentials", async () => {
  const calls = [];
  const publisher = makePublisher({ run: async (args, input) => {
    calls.push({ args, input });
    return calls.length === 1 ? "a".repeat(40) : JSON.stringify({ commit: { html_url: "https://github.com/example/commit/test" } });
  } });
  const result = await publisher.publish(makeSeed("2026-09-19"), 5);
  assert.equal(result.revision, 5);
  assert.ok(calls[0].args.includes("repos/Muddaqureshi/Aftercare-Muj-Podiatrist/contents/data/cases.csv"));
  const payload = JSON.parse(calls[1].input);
  assert.equal(payload.sha, "a".repeat(40));
  assert.equal(patientsFromCSV(Buffer.from(payload.content, "base64").toString()).length, 6);
  assert.equal(payload.branch, "main");
  assert.doesNotMatch(calls[1].input, /password|SMTP_PASS|token/);
});

test("publication failures propagate and do not leave the publisher locked", async () => {
  let calls = 0;
  const publisher = makePublisher({ run: async () => { calls++; throw new Error("GitHub conflict"); } });
  const patients = makeSeed("2026-09-19");
  await assert.rejects(() => publisher.publish(patients, 1), /GitHub conflict/);
  await assert.rejects(() => publisher.publish(patients, 1), /GitHub conflict/);
  assert.equal(calls, 2);
});
