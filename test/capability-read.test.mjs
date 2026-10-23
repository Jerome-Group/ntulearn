import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEvidence } from "../src/capabilities/read.mjs";

test("local evidence reading is size-bounded and recoverable after malformed data", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-evidence-"));
  const path = join(root, "evidence.json");
  assert.equal((await readEvidence(path)).status, "blocked");
  await writeFile(path, "{invalid");
  assert.equal((await readEvidence(path)).status, "failed");
  await writeFile(path, " ".repeat(101));
  assert.equal((await readEvidence(path, 100)).code, "EVIDENCE_SIZE");
  await writeFile(path, '{"okay":true}');
  assert.deepEqual((await readEvidence(path)).value, { okay: true });
});

test("local evidence rejects file aliases instead of reading their targets", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-evidence-alias-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const actual = join(root, "actual.json");
  const alias = join(root, "evidence.json");
  await writeFile(actual, '{"private":"retained original"}');
  await symlink(actual, alias);
  assert.deepEqual(await readEvidence(alias), { status: "failed", code: "EVIDENCE_UNREADABLE" });
});
