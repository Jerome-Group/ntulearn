import { join, resolve, relative, isAbsolute, sep } from "node:path";
import { recordingDisposition } from "./disposition.mjs";
import { mediaRecordingRoot } from "./storage.mjs";
import { catalogueJson, catalogueFingerprint } from "./catalogue-files.mjs";
import { assertCataloguePrivatePath } from "./catalogue-profile.mjs";
import { assertCatalogueBindings } from "./catalogue-course.mjs";

const inside = (root, path) => path.startsWith(root + sep);
const values = (media) =>
  [
    media?.video?.available === true ? media.video.path : null,
    media?.audio?.available === true ? media.audio.path : null,
  ].filter((value) => typeof value === "string");
export function catalogueMediaPath(value, roots) {
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0")) return null;
  const path = resolve(value);
  if (path.split(sep).includes(".runtime")) return null;
  for (const root of roots) {
    if (inside(root.logical, path)) return resolve(root.canonical, relative(root.logical, path));
    if (inside(root.canonical, path)) return path;
  }
  return null;
}
export async function catalogueRetainedMedia({ claims, store, reads, profileBinding, bindings }) {
  const roots = bindings;
  await assertCatalogueBindings(roots, { media: reads.media, profileBinding });
  const claimedPaths = new Map();
  for (const { course, job } of claims) {
    const checkpointFile =
      typeof job.recordingId === "string"
        ? reads.files.get(join(mediaRecordingRoot(store, job.recordingId), "transcript.state.json"))
        : null;
    const checkpoint = checkpointFile ? catalogueJson(checkpointFile) : null;
    const paths = [
      ...(checkpoint?.recordingId === job.recordingId
        ? [...values(checkpoint.media), checkpoint.artifacts?.media]
        : []),
      ...values(job.media),
      job.artifacts?.media,
      ...[job.placement?.videoPath, job.placement?.audioPath]
        .filter(Boolean)
        .map((path) => resolve(job.placement?.destination ?? course.path, path)),
    ];
    for (const value of paths) {
      const path = catalogueMediaPath(value, roots);
      if (!path) continue;
      const owners = claimedPaths.get(path) ?? new Set();
      owners.add(course.key + "\0" + job.recordingId);
      claimedPaths.set(path, owners);
    }
  }
  const proofs = new Map(),
    identities = new Map();
  for (const { course, job } of claims) {
    const unproven = (reason) => ({
      status: "unproven",
      reason,
      acousticVerification: "unrun",
      completeness: "unclaimed",
    });
    let access = unproven("ownership-unproven");
    if (proofs.has(job.recordingId)) continue;
    proofs.set(job.recordingId, { access });
    if (
      recordingDisposition(job) !== "recording" ||
      job.withdrawn ||
      job.stage === "withdrawn" ||
      job.safetyFailure !== undefined ||
      job.courseId !== course.courseId ||
      claims.filter((c) => c.job.recordingId === job.recordingId).length !== 1
    )
      continue;
    if (
      !["content-tree", "media-gallery"].some((surface) =>
        job.recordingId.startsWith(`${surface}:${course.courseId}:`),
      )
    )
      continue;
    if (
      !roots.some(
        (root) =>
          root.canonical === course.path &&
          root.logical === resolve(job.placement?.destination ?? ""),
      )
    )
      continue;
    const recordRoot = mediaRecordingRoot(store, job.recordingId),
      stateFile = reads.files.get(join(recordRoot, "transcript.state.json")),
      metadataFile = reads.files.get(join(recordRoot, "transcript.metadata.json"));
    if (!stateFile) continue;
    const state = catalogueJson(stateFile),
      metadata = metadataFile ? catalogueJson(metadataFile) : null;
    if (
      state.recordingId !== job.recordingId ||
      state.withdrawn ||
      state.stage === "withdrawn" ||
      state.safetyFailure !== undefined ||
      (metadata && metadata.recordingId !== job.recordingId)
    )
      continue;
    const normalize = (values) =>
      values.map((value) => catalogueMediaPath(value, roots)).filter(Boolean);
    const checkpoint = normalize([...values(state.media), state.artifacts?.media]),
      producer = metadata ? normalize(values(metadata.media)) : checkpoint;
    const placement = normalize(
      [job.placement?.videoPath, job.placement?.audioPath]
        .filter(Boolean)
        .map((path) => resolve(job.placement.destination, path)),
    );
    const explicitQueue = [...values(job.media), job.artifacts?.media].filter(
      (value) => typeof value === "string",
    );
    const queue = explicitQueue.length
      ? normalize(explicitQueue)
      : job.storageSurface === "media-gallery"
        ? checkpoint
        : placement;
    const permitted = (path) =>
      job.storageSurface === "media-gallery"
        ? inside(join(recordRoot, "media"), path)
        : inside(course.path, path) && placement.includes(path);
    const candidate = queue.find(
      (path) =>
        checkpoint.includes(path) &&
        producer.includes(path) &&
        permitted(path) &&
        claimedPaths.get(path)?.size === 1,
    );
    if (!candidate) continue;
    await assertCataloguePrivatePath(profileBinding, candidate);
    let media;
    try {
      media = await reads.media.read(
        candidate,
        job.storageSurface === "media-gallery" ? recordRoot : course.path,
      );
    } catch (error) {
      if (["ENOENT", "CATALOGUE_MEDIA_PATH_UNSAFE"].includes(error.code)) {
        proofs.set(job.recordingId, {
          access: unproven(error.code === "ENOENT" ? "media-missing" : "path-unsafe"),
        });
        continue;
      }
      throw error;
    }
    const pin = catalogueFingerprint(media);
    reads.files.set(candidate, pin);
    identities.set(candidate, media);
    access = {
      status: "verified",
      path: candidate,
      sha256: media.sha256,
      bytes: media.bytes,
      authority:
        "Unique current recording/course placement and retained queue/checkpoint/metadata media claims; bounded current file digest and physical identity.",
      acousticVerification: "unrun",
      completeness: "unclaimed",
    };
    proofs.set(job.recordingId, { access, identity: media });
  }
  const physical = new Map();
  for (const [id, proof] of proofs)
    if (proof.identity) {
      const key = `${proof.identity.identity.dev}:${proof.identity.identity.ino}`,
        owners = physical.get(key) ?? new Set();
      owners.add(id);
      physical.set(key, owners);
    }
  for (const [id, proof] of proofs)
    if (
      proof.identity &&
      physical.get(`${proof.identity.identity.dev}:${proof.identity.identity.ino}`).size !== 1
    )
      proofs.set(id, {
        access: {
          status: "unproven",
          reason: "ambiguous-physical-media",
          acousticVerification: "unrun",
          completeness: "unclaimed",
        },
      });
  return { proofs, identities };
}
