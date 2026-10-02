import { dirname, join, resolve, sep } from "node:path";
import { realpath, stat } from "node:fs/promises";
import { readMediaQueue } from "./queue.mjs";
import { mediaRecordingRoot } from "./storage.mjs";
import {
  inspectHistoricalSource,
  historicalParagraphs,
  historicalTextFlags,
  HISTORICAL_FORMAT_VERSION,
} from "./historical-format.mjs";
import {
  historicalReads,
  historicalDigest,
  historicalFailure,
  insideHistoricalRoot,
} from "./historical-files.mjs";
import { safeNativeTranscriptBody } from "./native-transcript-safety.mjs";
import { assertFormattedTranscript } from "./transcript.mjs";

export async function historicalInventory({ config, signal, reads = historicalReads({ signal }) }) {
  const roots = [];
  for (const course of config.courses) {
    const path = await reads.probe(() => realpath(course.destination));
    if (!(await reads.probe(() => stat(path))).isDirectory()) throw historicalFailure();
    roots.push({ path, courseKey: course.key, courseId: course.courseId });
  }
  const store = await reads.probe(() => realpath(config.media.mediaRoot));
  roots.push({ path: store, courseKey: null });
  for (let i = 0; i < roots.length; i++)
    for (let j = i + 1; j < roots.length; j++) {
      if (
        roots[i].path === roots[j].path ||
        insideHistoricalRoot(roots[i].path, roots[j].path) ||
        insideHistoricalRoot(roots[j].path, roots[i].path)
      )
        throw historicalFailure();
    }
  const files = [];
  for (const root of roots)
    for (const path of await reads.scan(root.path)) files.push(await reads.read(path));
  const byPath = new Map(files.map((file) => [file.path, file]));
  const queues = [],
    jobs = [];
  for (const course of config.courses) {
    const loaded = await readMediaQueue({
      statePath: config.statePath,
      courseKey: course.key,
      course,
      read: async (path) => {
        const canonical = await reads.probe(() => realpath(path));
        const file = await reads.read(canonical);
        queues.push(file);
        return file.content;
      },
    });
    for (const job of loaded.record?.queue ?? [])
      jobs.push({ job, course: roots.find((root) => root.courseKey === course.key) });
  }
  const sources = [],
    derivatives = files.filter((file) => /\.transcript\.md$/i.test(file.path));
  const editions = [];
  const used = new Set();
  for (const file of files.filter(
    (file) =>
      file.path.endsWith("transcript.raw.json") || file.path.split(sep).includes("provider"),
  )) {
    const native = !file.path.endsWith("transcript.raw.json");
    const metadata = parseJson(byPath.get(join(dirname(file.path), "transcript.metadata.json")));
    const state = parseJson(byPath.get(join(dirname(file.path), "transcript.state.json")));
    const inspected = inspectHistoricalSource(file.content, {
      native,
      duration: metadata?.duration ?? state?.duration,
      speechDuration: metadata?.speechDuration ?? state?.speechDuration,
    });
    const record = {
      path: file.path,
      sha256: file.sha256,
      kind: native ? "native" : "raw",
      valid: inspected.valid,
      flags: inspected.flags,
      timing: inspected.timing,
      association: "unassociated",
    };
    sources.push(record);
    if (native || !inspected.valid) continue;
    const identity = metadata?.recordingId;
    // Admission precedes any fresh retention of legacy identity/reference values.
    try {
      safeNativeTranscriptBody(metadata);
      safeNativeTranscriptBody(state ?? {});
    } catch {
      throw historicalFailure();
    }
    if (
      typeof identity !== "string" ||
      !identity ||
      metadata?.sourceSha256 !== file.sha256 ||
      mediaRecordingRoot(store, identity) !== dirname(file.path)
    )
      continue;
    const identityCourses = roots.filter(
      (root) =>
        root.courseId &&
        ["content-tree", "media-gallery"].some((surface) =>
          identity.startsWith(`${surface}:${root.courseId}:`),
        ),
    );
    const courseBoundIdentity = /^(?:content-tree|media-gallery):/.test(identity);
    const associations = [];
    for (const { job, course } of jobs) {
      if (
        job.recordingId !== identity ||
        identityCourses.length > 1 ||
        (courseBoundIdentity && identityCourses.length !== 1) ||
        (identityCourses.length === 1 && identityCourses[0] !== course) ||
        job.courseId !== course.courseId ||
        !job.placement?.formattedTranscriptPath
      )
        continue;
      const destination = await reads.probe(() => realpath(job.placement.destination));
      const formatted = resolve(destination, job.placement.formattedTranscriptPath);
      if (destination !== course.path || !insideHistoricalRoot(course.path, formatted))
        throw historicalFailure();
      const derivative = byPath.get(formatted);
      if (derivative?.sha256 !== metadata.formattedSha256) continue;
      associations.push({ job, course, derivative });
    }
    if (
      !associations.length &&
      state?.recordingId === identity &&
      state?.sourceSha256 === file.sha256 &&
      typeof state.artifacts?.formattedTranscript === "string"
    ) {
      const formatted = await reads
        .probe(() => realpath(state.artifacts.formattedTranscript))
        .catch((error) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
      const course = roots.find(
        (root) => root.courseKey && insideHistoricalRoot(root.path, formatted ?? ""),
      );
      const derivative = byPath.get(formatted);
      if (
        course &&
        identityCourses.length === 1 &&
        identityCourses[0] === course &&
        derivative?.sha256 === metadata.formattedSha256 &&
        (!state.formattedSha256 || state.formattedSha256 === derivative.sha256)
      )
        associations.push({
          course,
          derivative,
          job: {
            recordingId: identity,
            providerReference: metadata.recordingReference,
            title: "Retained transcript",
            placement: {},
          },
        });
    }
    const unique = new Map(
      associations.map((value) => [value.derivative.path + "\0" + value.course.courseKey, value]),
    );
    if (unique.size !== 1) {
      record.association = unique.size ? "ambiguous" : "missing-or-edited";
      continue;
    }
    const { job, course, derivative } = [...unique.values()][0];

    used.add(derivative.path);
    record.association = "proven";
    const priorFlags = historicalTextFlags(derivative.content.toString("utf8"));
    let lexical = "passed";
    try {
      assertFormattedTranscript(derivative.content.toString("utf8"), inspected.source.segments);
    } catch {
      lexical = "failed";
    }
    const item = {
      recordingId: identity,
      courseKey: course.courseKey,
      coursePath: course.path,
      originalPath: derivative.path,
      sourcePath: file.path,
      sourceSha256: file.sha256,
      originalSha256: derivative.sha256,
      metadataPath: join(dirname(file.path), "transcript.metadata.json"),
      statusPath: job.placement?.statusPath ? resolve(course.path, job.placement.statusPath) : null,
      originalFlags: priorFlags,
      sourceFlags: inspected.flags,
      timing: inspected.timing,
      lexical,
      eligible: inspected.eligible === true,
    };
    if (item.eligible) {
      try {
        item.markdown = historicalParagraphs(inspected.source);
        item.editionSha256 = historicalDigest(item.markdown);
      } catch {
        item.eligible = false;
        item.sourceFlags = [...item.sourceFlags, "lexical-format-rejected"];
      }
    }
    editions.push(item);
  }
  const claims = new Map();
  for (const edition of editions)
    claims.set(edition.originalPath, (claims.get(edition.originalPath) ?? 0) + 1);
  for (let index = editions.length - 1; index >= 0; index--) {
    if (claims.get(editions[index].originalPath) > 1) {
      const removed = editions.splice(index, 1)[0];
      used.delete(removed.originalPath);
      const source = sources.find((source) => source.path === removed.sourcePath);
      source.association = "ambiguous";
    }
  }
  const inputs = [...files, ...queues]
    .map(({ path, sha256, bytes }) => ({ path, sha256, bytes }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const records = derivatives.map((file) => ({
    path: file.path,
    sha256: file.sha256,
    association: used.has(file.path) ? "proven" : "unassociated-or-edited",
    flags: historicalTextFlags(file.content.toString("utf8")),
  }));
  const id = historicalDigest(
    JSON.stringify({ policy: HISTORICAL_FORMAT_VERSION, roots, inputs }),
  ).slice(0, 24);
  return {
    schemaVersion: 1,
    policy: HISTORICAL_FORMAT_VERSION,
    id,
    roots,
    inputs,
    sources,
    derivatives: records,
    editions,
  };
}

function parseJson(file) {
  try {
    return JSON.parse(file.content.toString("utf8"));
  } catch {
    return null;
  }
}
