import assert from "node:assert/strict";
import test from "node:test";
import { sessionPath } from "../src/media/session-path.mjs";
import { stableProviderReference } from "../src/media/external.mjs";
import { kalturaReferenceOf } from "../src/media/kaltura.mjs";
import { directMediaReferenceOf } from "../src/media/direct.mjs";
import { classifyRecordingCandidate } from "../src/media/classification.mjs";
import {
  mediaCourseStatus,
  writeMediaCourseStatus,
  writeMediaRecordingStatus,
} from "../src/media/status.mjs";

test("bounded session component inspection excludes values before sanitization or hashing", () => {
  for (const key of ["ks", "%6bs", "k%73", "%6b%73", "KS"]) {
    const first = `https://media.test/api/${key}/synthetic-private-A/recording`;
    const second = first.replace("synthetic-private-A", "synthetic-private-B");
    assert.equal(sessionPath(first).sessionBearing, true);
    assert.equal(sessionPath(first).value, sessionPath(second).value);
    assert.equal(
      stableProviderReference("candidate", first),
      stableProviderReference("candidate", second),
    );
    assert.equal(
      stableProviderReference("candidate", { resource: `text ${first}` }),
      stableProviderReference("candidate", { resource: `text ${second}` }),
    );
    assert.equal(stableProviderReference("candidate", first).includes("synthetic-private"), false);
  }
  assert.equal(
    sessionPath("/api%2f%6bs%2fsynthetic-private%2frecording").value,
    "/api/ks/session-redacted",
  );
  assert.equal(
    sessionPath("/ks/value?entry_id=stable").value,
    "/ks/session-redacted?entry_id=stable",
  );
  assert.equal(sessionPath("x".repeat(65_537)).uncertain, true);
});

test("ordinary paths and independent non-secret IDs remain distinguishable", () => {
  for (const value of [
    "/lectures/physics.mp4",
    "/math/50%25.mp4",
    "/docs/asks/value",
    "/ks/",
    "/%zz/value",
    "https://ks/lecture.mp4",
    "//ks/lecture.mp4",
    "https://safe.test/lecture.mp4?next=/ks/ordinary",
  ]) {
    assert.equal(sessionPath(value).value, value);
    assert.equal(sessionPath(value).sessionBearing, false);
  }
  assert.notEqual(
    stableProviderReference("candidate", "/ks/one/lecture-A"),
    stableProviderReference("candidate", "/ks/two/lecture-B"),
  );
  assert.notEqual(
    stableProviderReference("candidate", "/player?entry_id=A&ks=one"),
    stableProviderReference("candidate", "/player?entry_id=B&ks=two"),
  );
  assert.equal(
    stableProviderReference("candidate", "/player?entry_id=A&ks=one"),
    stableProviderReference("candidate", "/player?entry_id=A&ks=two"),
  );
  assert.equal(
    kalturaReferenceOf("https://media.kaltura.test/entry_id/entry-A/ks/private"),
    "entry:entry-A",
  );
  assert.equal(
    kalturaReferenceOf("https://media.kaltura.test/ks/private/player").includes("private"),
    false,
  );
  assert.equal(
    directMediaReferenceOf("https://video.test/ks/private/lecture.mp4").includes("private"),
    false,
  );
  assert.equal(
    classifyRecordingCandidate({ value: "/lectures/physics.mp4", sourceKind: "embedded-player" })
      .provider,
    "direct",
  );
  assert.equal(
    classifyRecordingCandidate({
      value: "https://media.kaltura.test/ks/private/player?entry_id=entry-A",
      sourceKind: "embedded-player",
    }).disposition,
    "recording",
  );
  assert.equal(
    classifyRecordingCandidate({
      value: "https://video.test/ks/private/lecture.mp4",
      sourceKind: "embedded-player",
    }).classificationEvidence,
    "session-dependent-reference",
  );
});

test("retained status rendering excludes session paths without changing retained identities", async () => {
  const job = {
    recordingId: "content-tree:course:item:path:media.test/_6bs/synthetic-private-old/player",
    providerReference: "path:media.test/%6bs/synthetic-private-old/player",
    provider: "unsupported",
    disposition: "unresolved",
    title: "Synthetic lecture",
    sourceKind: "embedded-player",
    placement: { destination: "/synthetic-course", statusPath: "lecture.media-status.md" },
    attempts: 3,
    checkpoint: { at: "2026-10-03", reason: "Fixture" },
    artifacts: {},
  };
  const before = JSON.stringify(job);
  const course = { key: "synthetic", destination: "/synthetic-course", mediaMode: "pilot" };
  const status = mediaCourseStatus({ course, queue: [job] });
  assert.equal(JSON.stringify(status).includes("synthetic-private"), false);
  const outputs = [];
  const write = async (_path, bytes) => outputs.push(bytes);
  await writeMediaCourseStatus({ course, queue: [job], write });
  await writeMediaRecordingStatus({ appearance: job, write });
  assert.equal(outputs.length, 2);
  assert.equal(outputs.join("").includes("synthetic-private"), false);
  assert.equal(JSON.stringify(job), before);
});
