import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { readRecoveryRetainedCandidate } from "../src/media/recovery-retained-candidate.mjs";
import { recoverTranscriptSources } from "../src/media/recovery.mjs";
import { recoveryFixture } from "./fixtures/media-recovery.mjs";

test("retained report labels cannot override independently assessed native/source evidence", async (t) => {
  const f = await recoveryFixture(t);
  await recoverTranscriptSources({ ...f.options, mode: "run" }, f.dependencies);
  const report = JSON.parse(await readFile(join(f.outputDirectory, "recovery.json")));
  const options = {
    output: f.outputDirectory,
    recording: report.manifest.recordings[0],
    retained: report.candidates[0],
    maximumDuration: 300,
  };
  assert.equal((await readRecoveryRetainedCandidate(options)).candidate.eligible, true);
  await assert.rejects(
    readRecoveryRetainedCandidate({
      ...options,
      retained: { ...options.retained, eligible: false },
    }),
    { code: "RECOVERY_CANDIDATE_REVIEW" },
  );
  await assert.rejects(readRecoveryRetainedCandidate({ ...options, maximumDuration: 1 }), {
    code: "RECOVERY_CANDIDATE_INVALID",
  });
});
