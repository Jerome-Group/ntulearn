import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdir, mkdtemp, readFile, rm, writeFile, copyFile, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { run } from "./process.mjs";
import { mirrorSources, snapshot } from "./sources.mjs";
import { jarPath, jarSha256, verifyJar } from "./setup.mjs";

const skill = fileURLToPath(new URL("..", import.meta.url));
const root = fileURLToPath(new URL("../../../..", import.meta.url));
assert(
  process.argv.slice(2).every((arg) => arg === "--self-test"),
  "Run check.mjs with optional --self-test.",
);
await mkdir(join(root, ".scratch"), { recursive: true });
const evidence = await mkdtemp(join(root, ".scratch/formal-additive-"));
console.log(`Evidence: ${evidence}`);
const summary = { outcome: "failed", model: [], native: [], fixtures: [], jarSha256 };
const started = performance.now();

async function model(label, expectedInvariant) {
  const directory = join(evidence, label);
  await mkdir(directory);
  await copyFile(join(skill, "Publication.tla"), join(directory, "Publication.tla"));
  let config = await readFile(join(skill, "Publication.cfg"), "utf8");
  if (label === "model-replace")
    config = config.replace("ReplaceClaim = FALSE", "ReplaceClaim = TRUE");
  if (label === "model-truncate")
    config = config.replace("TruncateStage = FALSE", "TruncateStage = TRUE");
  await writeFile(join(directory, "Publication.cfg"), config);
  const began = performance.now();
  const result = await run(
    process.env.JAVA ?? "java",
    [
      "-XX:+UseParallelGC",
      "-Xmx512m",
      "-cp",
      jarPath,
      "tlc2.TLC",
      "-workers",
      "1",
      "-fp",
      "0",
      "-seed",
      "1",
      "-config",
      "Publication.cfg",
      "Publication.tla",
    ],
    directory,
    180000,
  );
  await writeFile(join(directory, "process.json"), JSON.stringify(result, null, 2));
  await writeFile(join(directory, "tlc.log"), result.stdout + result.stderr);
  assert.equal(result.stopped, null, "TLC stopped. Inspect process.json before retrying.");
  const log = result.stdout + result.stderr;
  if (expectedInvariant) {
    assert.notEqual(result.code, 0, "Broken model unexpectedly passed.");
    assert(
      log.includes(`Invariant ${expectedInvariant} is violated.`),
      `Expected ${expectedInvariant} counterexample. Inspect tlc.log.`,
    );
  } else {
    assert.equal(
      result.code,
      0,
      "TLC failed. Inspect tlc.log. If Java is absent, install Java 11+ or set JAVA to its executable.",
    );
    assert(
      log.includes("Model checking completed. No error has been found."),
      "TLC did not exhaust the model.",
    );
  }
  const states = log.match(/([\d,]+) states generated, ([\d,]+) distinct states found/);
  const record = {
    label,
    expectedInvariant,
    generated: states?.[1],
    distinct: states?.[2],
    milliseconds: Math.round(performance.now() - began),
  };
  summary.model.push(record);
  console.log(
    `${label}: ${expectedInvariant ?? "PASS"}, ${record.distinct} distinct states, ${record.milliseconds}ms`,
  );
}

async function native(sources, label, mutant = null) {
  const directory = join(evidence, label);
  await mkdir(directory);
  const fixtureRoot = await mkdtemp(join(tmpdir(), "ntulearn-publication-"));
  const mirror = join(fixtureRoot, "mirror");
  let settled = true;
  try {
    await mirrorSources(sources, skill, mirror, directory, mutant);
    const scenarios =
      mutant === "replace"
        ? ["different"]
        : mutant === "truncate"
          ? ["fresh"]
          : [
              "fresh",
              "different",
              "same",
              "occupied-different",
              "occupied-same",
              "directory",
              "symlink",
            ];
    for (const scenario of scenarios) {
      const fixture = join(fixtureRoot, scenario);
      await mkdir(fixture);
      const output = join(directory, `${scenario}.json`);
      settled = false;
      const result = await run(
        process.execPath,
        [join(skill, "scripts/probe.mjs"), mirror, fixture, scenario, output],
        root,
        15000,
      );
      settled = result.settled;
      await writeFile(join(directory, `${scenario}.process.json`), JSON.stringify(result, null, 2));
      assert.equal(result.stopped, null, "Native probe stopped. Inspect its process record.");
      assert.equal(result.code, 0, `Native probe failed. Inspect ${directory}.`);
      const observed = JSON.parse(await readFile(output, "utf8"));
      assert.deepEqual(observed.partials, [], "Private staging files survived settlement.");
      if (mutant === "replace") {
        const mismatch = observed.violations.find(
          (item) => item.invariant === "FirstOccupantPreserved",
        );
        assert(mismatch, "Replacement mutant did not violate FirstOccupantPreserved.");
        assert.equal(
          mismatch.expected.bytes,
          Buffer.from("Writer A complete body\n").toString("base64"),
        );
        assert.equal(
          mismatch.actual.bytes,
          Buffer.from("Writer B complete body\n").toString("base64"),
        );
        assert.deepEqual(observed.outcomes, [
          { writer: "A", value: true },
          { writer: "B", value: true },
        ]);
      } else if (mutant === "truncate") {
        const mismatch = observed.violations.find(
          (item) => item.invariant === "SuccessfulBytesComplete",
        );
        assert(mismatch, "Truncation mutant did not violate SuccessfulBytesComplete.");
        assert.equal(mismatch.expected, Buffer.from("Writer A complete body\n").toString("base64"));
        assert.equal(mismatch.actual, Buffer.from("Writer A complete body").toString("base64"));
        assert.deepEqual(observed.outcomes, [{ writer: "A", value: true }]);
      } else {
        assert.deepEqual(observed.violations, []);
      }
      summary.native.push({
        label,
        scenario,
        violations: observed.violations.map((item) => item.invariant),
      });
    }
  } finally {
    if (settled) await rm(fixtureRoot, { recursive: true, force: true });
    else console.error(`Preserved unsettled fixture: ${fixtureRoot}`);
    const remains = await lstat(fixtureRoot).catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    summary.fixtures.push({ label, fixtureRoot, settled, removed: remains === null });
  }
  console.log(`${label}: PASS`);
}

try {
  await verifyJar();
  const java = await run(process.env.JAVA ?? "java", ["-version"], root);
  await writeFile(join(evidence, "java.json"), JSON.stringify(java, null, 2));
  assert.equal(java.code, 0, "Java unavailable. Install Java 11+ or set JAVA to its executable.");
  const head = await run("git", ["rev-parse", "HEAD"], root);
  summary.head = head.stdout.trim();
  const sources = await snapshot(root, skill, evidence);
  await native(sources, "native-pristine");
  await model("model-pristine");
  if (process.argv.includes("--self-test")) {
    await native(sources, "native-replace", "replace");
    await native(sources, "native-truncate", "truncate");
    await model("model-replace", "FirstOccupantPreserved");
    await model("model-truncate", "SuccessfulBytesComplete");
    await model("model-final-pristine");
    await native(sources, "native-final-pristine");
  }
  summary.outcome = "passed";
} catch (error) {
  summary.error = error.stack;
  console.error(error.message);
  process.exitCode = 1;
} finally {
  summary.milliseconds = Math.round(performance.now() - started);
  await writeFile(resolve(evidence, "run.json"), JSON.stringify(summary, null, 2));
  console.log(`${summary.outcome.toUpperCase()}: ${evidence}`);
}
