import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  readEvaluationManifest,
  assertEvaluationInputsUnchanged,
} from "../src/media/evaluation-manifest.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-evaluation-manifest-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "audio.wav"), "audio");
  await writeFile(join(root, "reference.txt"), "Let x equal minus two.");
  const manifest = {
    version: 1,
    budgets: {
      maxFixtureSeconds: 300,
      maxInputBytes: 1000,
      maxOutputBytes: 10000,
      jobTimeoutMs: 1000,
      processTimeoutMs: 500,
    },
    fixtures: [
      {
        audio: { path: "audio.wav", sha256: sha("audio") },
        reference: {
          kind: "generated-script",
          path: "reference.txt",
          sha256: sha("Let x equal minus two."),
          provenance: {
            method: "speech-synthesis",
            sourceSha256: sha("audio"),
            referenceSha256: sha("Let x equal minus two."),
          },
        },
      },
    ],
  };
  const path = join(root, "manifest.json");
  await writeFile(path, JSON.stringify(manifest));
  return { root, manifest, path };
}

test("validates explicit budgets and immutable reference provenance without reading a session", async (t) => {
  const held = await fixture(t);
  const parsed = await readEvaluationManifest(held.path);
  assert.equal(parsed.fixtures[0].id, "fixture-1");
  assert.equal(parsed.fixtures[0].reference.kind, "generated-script");
  await assertEvaluationInputsUnchanged(parsed);
  await writeFile(join(held.root, "audio.wav"), "changed");
  await assert.rejects(assertEvaluationInputsUnchanged(parsed), /hashes/);
});

test("rejects missing budgets, mismatched annotation and unknown manifest versions", async (t) => {
  for (const mutate of [
    (m) => {
      delete m.budgets;
    },
    (m) => {
      m.version = 2;
    },
    (m) => {
      m.fixtures[0].reference.kind = "annotated-audio";
    },
  ]) {
    const held = await fixture(t);
    mutate(held.manifest);
    await writeFile(held.path, JSON.stringify(held.manifest));
    await assert.rejects(readEvaluationManifest(held.path), /private evaluation/);
  }
});

test("prevalidation hashing honors external checkpoints without modifying inputs", async (t) => {
  const held = await fixture(t);
  const controller = new globalThis.AbortController();
  const reason = new Error("fixture checkpoint");
  const pending = readEvaluationManifest(held.path, { signal: controller.signal });
  controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
  assert.equal((await readEvaluationManifest(held.path)).fixtures[0].audio.sha256, sha("audio"));
});
