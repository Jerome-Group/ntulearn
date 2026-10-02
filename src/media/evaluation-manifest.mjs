import { withEvaluationRead } from "./evaluation-read.mjs";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const SHA256 = /^[0-9a-f]{64}$/;
const REFERENCES = new Set(["generated-script", "annotated-audio", "unavailable"]);
const MAXIMUM_BUDGETS = Object.freeze({
  maxFixtureSeconds: 3600,
  maxInputBytes: 1024 * 1024 * 1024,
  maxOutputBytes: 2 * 1024 * 1024 * 1024,
  jobTimeoutMs: 15 * 60 * 1000,
  processTimeoutMs: 5 * 60 * 1000,
});

export function readEvaluationManifest(path, options) {
  return withEvaluationRead((signal) => readManifest(path, signal), options);
}

async function readManifest(path, signal) {
  signal.throwIfAborted();
  const absolute = resolve(path);
  const info = await lstat(absolute);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 256 * 1024)
    throw invalid("EVALUATION_MANIFEST_INVALID");
  const manifest = JSON.parse(await readFile(absolute, { encoding: "utf8", signal }));
  if (
    manifest.version !== 1 ||
    !Array.isArray(manifest.fixtures) ||
    !manifest.fixtures.length ||
    manifest.fixtures.length > 8
  )
    throw invalid("EVALUATION_MANIFEST_INVALID");
  for (const [key, maximum] of Object.entries(MAXIMUM_BUDGETS)) {
    const value = manifest.budgets?.[key];
    if (!Number.isSafeInteger(value) || value <= 0 || value > maximum)
      throw invalid("EVALUATION_BUDGET_INVALID");
  }
  if (manifest.budgets.processTimeoutMs > manifest.budgets.jobTimeoutMs)
    throw invalid("EVALUATION_BUDGET_INVALID");
  if (
    manifest.interruptionAfterMs !== undefined &&
    (!Number.isSafeInteger(manifest.interruptionAfterMs) ||
      manifest.interruptionAfterMs <= 0 ||
      manifest.interruptionAfterMs >= manifest.budgets.processTimeoutMs)
  )
    throw invalid("EVALUATION_BUDGET_INVALID");
  const fixtures = [];
  for (const [index, entry] of manifest.fixtures.entries()) {
    const audio = await checkedFile(
      entry.audio,
      dirname(absolute),
      manifest.budgets.maxInputBytes,
      signal,
    );
    const reference = entry.reference;
    if (!reference || !REFERENCES.has(reference.kind))
      throw invalid("EVALUATION_REFERENCE_INVALID");
    let checkedReference = { kind: "unavailable" };
    if (reference.kind !== "unavailable") {
      const file = await checkedFile(reference, dirname(absolute), 64 * 1024, signal);
      const method =
        reference.kind === "generated-script" ? "speech-synthesis" : "listening-annotation";
      if (
        reference.provenance?.method !== method ||
        reference.provenance.sourceSha256 !== audio.sha256 ||
        reference.provenance.referenceSha256 !== file.sha256
      )
        throw invalid("EVALUATION_REFERENCE_INVALID");
      const text = await readFile(file.path, { encoding: "utf8", signal });
      if (!text.trim()) throw invalid("EVALUATION_REFERENCE_INVALID");
      checkedReference = {
        kind: reference.kind,
        ...file,
        text,
        provenance: { method, sourceSha256: audio.sha256, referenceSha256: file.sha256 },
      };
    }
    fixtures.push({ id: `fixture-${index + 1}`, audio, reference: checkedReference });
  }
  return {
    version: 1,
    budgets: Object.fromEntries(
      Object.keys(MAXIMUM_BUDGETS).map((key) => [key, manifest.budgets[key]]),
    ),
    interruptionAfterMs: manifest.interruptionAfterMs ?? null,
    fixtures,
  };
}

export function assertEvaluationInputsUnchanged(manifest, options) {
  return withEvaluationRead((signal) => checkInputs(manifest, signal), options);
}
async function checkInputs(manifest, signal) {
  for (const fixture of manifest.fixtures) {
    await checkedFile(fixture.audio, "/", manifest.budgets.maxInputBytes, signal);
    if (fixture.reference.kind !== "unavailable")
      await checkedFile(fixture.reference, "/", 64 * 1024, signal);
  }
}

async function checkedFile(value, root, maximumBytes, signal) {
  signal.throwIfAborted();
  if (!value || typeof value.path !== "string" || !value.path.trim() || !SHA256.test(value.sha256))
    throw invalid("EVALUATION_INPUT_INVALID");
  const path = resolve(root, value.path);
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximumBytes)
    throw invalid("EVALUATION_INPUT_INVALID");
  const digest = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path, { signal })) {
    signal.throwIfAborted();
    bytes += chunk.length;
    if (bytes > maximumBytes) throw invalid("EVALUATION_INPUT_INVALID");
    digest.update(chunk);
  }
  if (digest.digest("hex") !== value.sha256) throw invalid("EVALUATION_INPUT_CHANGED");
  return { path, sha256: value.sha256, bytes };
}

function invalid(code) {
  const error = new Error(
    "Check the private evaluation manifest, hashes, reference provenance and budgets, then retry plan.",
  );
  error.code = code;
  return error;
}
