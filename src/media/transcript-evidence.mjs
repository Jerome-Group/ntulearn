import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import { assertMediaArtifactPath, mediaRecordingRoot } from "./storage.mjs";
import { markGlobalMediaSafety, unconfirmedMediaCleanupCode } from "./errors.mjs";
import { isMediaJobComplete } from "./completeness.mjs";
import { withCapacityDeadline } from "./capacity-deadline.mjs";
import { closeMediaProbeHandle } from "./probe-settlement.mjs";

const EVIDENCE_IO = Object.freeze({ open, stat, assertPath: assertMediaArtifactPath });

export async function mediaArtifactEvidenceUpdate(
  job,
  { mediaRoot, course, resolveRoot = realpath, io = EVIDENCE_IO, probeTimeoutMs = 5000 } = {},
) {
  if (!Number.isSafeInteger(probeTimeoutMs) || probeTimeoutMs <= 0 || probeTimeoutMs > 5000)
    throw new Error(
      "Artifact evidence requires a positive probe deadline no longer than five seconds.",
    );
  const probe = { io, timeoutMs: probeTimeoutMs };
  if (job.safetyFailure !== undefined || !isMediaJobComplete(job)) return null;
  const artifacts = job.artifacts ?? {};
  const sourceRoot =
    typeof mediaRoot === "string" ? mediaRecordingRoot(resolve(mediaRoot), job.recordingId) : null;
  const destination = course?.destination;
  const raw =
    sourceRoot && artifacts.rawTranscript === resolve(sourceRoot, "transcript.raw.json")
      ? await artifactBytes(artifacts.rawTranscript, mediaRoot, probe)
      : null;
  const reference = await ownedFormattedReference(job, destination, resolveRoot, probe);
  const formatted = reference ? await artifactBytes(reference.path, reference.root, probe) : null;
  let sourceSha256 = job.sourceSha256;
  let formattedSha256 = job.formattedSha256;
  let aliasProof = !reference?.alias;
  if (raw && formatted && (reference?.alias || !sourceSha256 || !formattedSha256)) {
    const proofs = [];
    for (const filename of ["transcript.metadata.json", "transcript.state.json"]) {
      const body = await artifactBytes(resolve(sourceRoot, filename), mediaRoot, probe);
      let proof;
      try {
        proof = body ? JSON.parse(body.toString("utf8")) : null;
      } catch {
        proof = null;
      }
      if (
        proof?.recordingId === job.recordingId &&
        /^[0-9a-f]{64}$/.test(proof.sourceSha256) &&
        /^[0-9a-f]{64}$/.test(proof.formattedSha256)
      ) {
        proofs.push(proof);
      } else if (body && reference?.alias) {
        proofs.push(null);
      }
    }
    const owned = proofs.find(Boolean);
    aliasProof = Boolean(
      owned &&
      proofs.every(
        (proof) =>
          proof &&
          proof.sourceSha256 === owned.sourceSha256 &&
          proof.formattedSha256 === owned.formattedSha256,
      ) &&
      (!sourceSha256 || sourceSha256 === owned.sourceSha256) &&
      (!formattedSha256 || formattedSha256 === owned.formattedSha256),
    );
    sourceSha256 ??= owned?.sourceSha256;
    formattedSha256 ??= owned?.formattedSha256;
  }
  const bindingStable =
    !reference?.alias ||
    (await withCapacityDeadline(reference.unchanged, { timeoutMs: probeTimeoutMs }));
  const sourceChanged = raw && sourceSha256 && digest(raw) !== sourceSha256;
  const formattedChanged = formatted && formattedSha256 && digest(formatted) !== formattedSha256;
  const proofMissing = raw && formatted && (!sourceSha256 || !formattedSha256);
  if (
    raw &&
    formatted &&
    !sourceChanged &&
    !formattedChanged &&
    !proofMissing &&
    aliasProof &&
    bindingStable
  ) {
    if (reference.alias && artifacts.formattedTranscript !== reference.path)
      return {
        sourceSha256,
        formattedSha256,
        artifacts: { ...artifacts, formattedTranscript: reference.path },
      };
    return job.sourceSha256 && job.formattedSha256 ? null : { sourceSha256, formattedSha256 };
  }
  const requiresReview = Boolean(
    sourceChanged ||
    formattedChanged ||
    proofMissing ||
    (!raw && formatted) ||
    !aliasProof ||
    !bindingStable ||
    (destination && !reference),
  );
  const limitation = requiresReview
    ? "Preserved transcript evidence changed, its source is missing, or ownership digests are unavailable. Existing artifacts retained; explicit regeneration or Owner review is required."
    : "Recorded transcript artifacts are missing. Safe retry will recreate missing artifacts without replacing existing files.";
  return {
    complete: false,
    stage: requiresReview ? "failed" : "queued",
    verdict: requiresReview ? "red" : "yellow",
    retryable: !requiresReview,
    transcript: { ...job.transcript, complete: false },
    limitations: [...new Set([...(job.limitations ?? []), limitation])],
  };
}

async function ownedFormattedReference(job, destination, resolveRoot, { io, timeoutMs }) {
  const path = job.artifacts?.formattedTranscript;
  if (
    typeof destination !== "string" ||
    typeof path !== "string" ||
    !isAbsolute(path) ||
    /[\0\r\n]|:\/\//.test(path)
  )
    return null;
  const root = resolve(destination),
    target = resolve(path);
  const recorded = job.placement?.destination,
    relative = job.placement?.formattedTranscriptPath;
  if (target.startsWith(root + sep) && (typeof recorded !== "string" || resolve(recorded) === root))
    return { path: target, root, alias: false };
  if (
    typeof recorded !== "string" ||
    !isAbsolute(recorded) ||
    typeof relative !== "string" ||
    isAbsolute(relative) ||
    /[\0\r\n\\]/.test(recorded + relative) ||
    relative.split("/").some((part) => !part || part === "." || part === "..")
  )
    return null;
  return withCapacityDeadline(
    async (active) => {
      let actual, info;
      try {
        active();
        actual = await resolveRoot(root);
        active();
        if ((await resolveRoot(recorded)) !== actual) return null;
        active();
        if (
          ![
            resolve(recorded, relative),
            resolve(root, relative),
            resolve(actual, relative),
          ].includes(target)
        )
          return null;
        info = await io.stat(actual);
        active();
        if (!info.isDirectory()) return null;
      } catch (error) {
        if (unconfirmedMediaCleanupCode(error)) throw error;
        return null;
      }
      const canonical = resolve(actual, relative);
      active();
      await io.assertPath(canonical, actual, { active });
      active();
      const unchanged = async (checkActive) => {
        try {
          checkActive();
          if ((await resolveRoot(recorded)) !== actual) return false;
          checkActive();
          if ((await resolveRoot(root)) !== actual) return false;
          checkActive();
          const now = await io.stat(actual);
          checkActive();
          return now.dev === info.dev && now.ino === info.ino;
        } catch (error) {
          if (unconfirmedMediaCleanupCode(error)) throw error;
          return false;
        }
      };
      return { path: canonical, root: actual, alias: true, unchanged };
    },
    { timeoutMs },
  );
}

async function artifactBytes(path, root, { io, timeoutMs }) {
  if (typeof path !== "string" || !path.startsWith("/") || /[\0\r\n]|:\/\//.test(path)) return null;
  const target = resolve(path);
  const boundary = resolve(root);
  if (!target.startsWith(`${boundary}${sep}`)) return null;
  return withCapacityDeadline(
    async (active) => {
      active();
      await io.assertPath(target, boundary, { active });
      active();
      const handle = await io.open(
        target,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        active();
        const before = await handle.stat();
        active();
        if (!before.isFile() || before.size > 32 * 1024 ** 2)
          throw new Error("Artifact evidence is not a bounded regular file.");
        if (!before.size) return null;
        const parts = [],
          buffer = Buffer.alloc(64 * 1024);
        let bytes = 0;
        while (true) {
          active();
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
          active();
          if (!bytesRead) break;
          bytes += bytesRead;
          if (bytes > before.size) throw new Error("Artifact evidence grew during verification.");
          parts.push(Buffer.from(buffer.subarray(0, bytesRead)));
        }
        const body = Buffer.concat(parts);
        active();
        const after = await handle.stat();
        active();
        await io.assertPath(target, boundary, { active });
        active();
        const current = await io.stat(target);
        active();
        if (
          body.length !== before.size ||
          after.mtimeMs !== before.mtimeMs ||
          after.size !== before.size ||
          current.dev !== before.dev ||
          current.ino !== before.ino ||
          current.mtimeMs !== before.mtimeMs
        )
          throw new Error("Artifact evidence changed during verification.");
        return body;
      } finally {
        await closeMediaProbeHandle(handle);
      }
    },
    { timeoutMs },
  ).catch((error) => {
    if (error.code === "ENOENT") return null;
    const failure = new Error(
      `Transcript evidence cannot be read (${error.code ?? "filesystem error"}). Check artifact permissions and the mounted course/Media store before retrying.`,
      { cause: error },
    );
    failure.code = error.code;
    throw markGlobalMediaSafety(failure);
  });
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}
