import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { attachmentState } from "./attachment-state.mjs";
import { expectedFiles } from "./expected.mjs";
import { isFilePresent } from "./files.mjs";
import { numberingOf } from "./numbering.mjs";
import { assertDestinationPath, safeSegment, unnumbered } from "./paths.mjs";
import { resolveSourceEditions } from "./source-editions.mjs";
import { courseState } from "./state.mjs";
import { renumberFile, renumberRecoveries } from "./renumber-files.mjs";

// Why something the numbering has moved was left where it is. Said in the report rather than
// counted, because each is a different fact about the destination and only the first is ordinary.
const CHANGED = "it has changed since the sync wrote it";
const UNRECORDED = "no recorded digest, so there is nothing to hold it against";
const FOLDER_REFUSAL =
  "Folder renumbering is unavailable because portable Node cannot exclusively claim the new directory name. Keep this folder name or rename it manually after checking both names; files can still be renumbered inside it.";
const STATE_CONFLICT =
  "State does not match this current source identity or accepted digest; run sync before retrying";
const SOURCE_FAILURES = {
  SOURCE_IDENTITY_UNRESOLVED:
    "source identity is missing or repeated; inspect the source before retrying",
  SOURCE_REVISION_UNRESOLVED: "current source revision is unproven; run sync before retrying",
  SOURCE_PLACEMENT_AMBIGUOUS:
    "source placement is ambiguous; inspect the retained paths before retrying",
  SOURCE_PUBLICATION_CONFLICT:
    "source placement is not an unchanged regular file; inspect it before retrying",
};

// Renaming stays opt-in because changing a path can break student links (ADR-0010/0031).
// Source selection alone does not grant permission. State and current-page accepted-byte proof
// remain separate requirements (ADR-0029).
export async function renumberCourse({ client, course, state }) {
  const pending = await renumberRecoveries(course.destination);
  if (pending.length)
    return {
      key: course.key,
      course: course.key,
      destination: course.destination,
      renamed: [],
      recoveries: pending,
    };
  const snapshot = await client.readCourse(course.courseId);
  const previous = courseState(state, course.key);

  let walked = [];
  for await (const expected of expectedFiles({ client, courseId: course.courseId, snapshot })) {
    walked.push(expected);
  }
  walked = await resolveSourceEditions({ walked, destination: course.destination, verify: true });
  const numbering = numberingOf(
    course.destination,
    walked.map((expected) => expected.placement.segments),
  );

  const moving = [];
  const kept = [];
  const blocked = [];
  for (const expected of walked) {
    const { file, trail, path, segments } = expected.placement;
    const named = { file: file ?? unnumbered(segments.at(-1)), trail };
    const at = path ?? segments.join("/");
    if (expected.sourceFailure) {
      kept.push({ ...named, path: at, why: SOURCE_FAILURES[expected.sourceFailure] });
      continue;
    }
    const held = await heldAt(numbering, course.destination, expected);
    if (held === null) continue;
    if (held.why) {
      kept.push({ ...named, path: at, why: held.why });
      continue;
    }
    const { from } = held;
    const currentPrefix = segments.at(-1).match(/^\d+ /)?.[0];
    const leaf = currentPrefix ? basename(from).replace(/^\d+ /, currentPrefix) : basename(from);
    const to = join(dirname(from), safeSegment(leaf));
    if (to === from) continue;
    if (expected.kind === "folder") {
      blocked.push({ ...named, from, to, why: FOLDER_REFUSAL });
      continue;
    }

    const permission = await filePermission(expected, from, previous);
    if (permission.kind === "refused")
      kept.push({
        ...named,
        path: at,
        onDisk: relative(course.destination, from),
        why: permission.why,
      });
    else moving.push({ ...named, from, to, proof: permission.proof });
  }

  const renamed = [];
  const recoveries = [];
  for (const each of moving) {
    const outcome = await renumberFile({ destination: course.destination, ...each });
    if (outcome.kind === "moved") renamed.push(each);
    else if (outcome.kind === "kept") blocked.push({ ...each, why: outcome.why });
    else {
      recoveries.push(outcome);
      break;
    }
  }

  return {
    key: course.key,
    course: snapshot.course.displayName,
    destination: course.destination,
    renamed: renamed.map((each) => said(each, course.destination)),
    ...(kept.length ? { kept } : {}),
    ...(blocked.length
      ? {
          blocked: blocked.map((each) => ({
            ...said(each, course.destination),
            why: each.why,
          })),
        }
      : {}),
    ...(recoveries.length ? { recoveries } : {}),
  };
}

async function heldAt(numbering, destination, expected) {
  const { segments } = expected.placement;
  let found = expected.sourcePath;
  if (found) {
    await assertDestinationPath(destination, resolve(destination, found));
    if (!(await isFilePresent(resolve(destination, found)))) return null;
  } else if (expected.kind === "folder") found = await numbering.directory(segments);
  else {
    const candidates = await numbering.findAll(segments);
    if (candidates.length > 1) return { why: SOURCE_FAILURES.SOURCE_PLACEMENT_AMBIGUOUS };
    found = candidates[0] ?? null;
  }
  if (found === null) return null;
  return { from: resolve(destination, found) };
}

async function filePermission(expected, from, previous) {
  let digest, bytes, kind;
  if (expected.kind === "attachment") {
    const { record, identityConflict } = attachmentState(
      previous,
      expected.source,
      expected.attachment,
    );
    if (identityConflict) return { kind: "refused", why: STATE_CONFLICT };
    if (!/^[a-f0-9]{64}$/.test(record?.sha256 ?? "")) return { kind: "refused", why: UNRECORDED };
    if (expected.provenance && record.sha256 !== expected.provenance.sha256)
      return { kind: "refused", why: STATE_CONFLICT };
    digest = record.sha256;
    bytes = expected.provenance?.bytes;
    kind = "attachment-state";
  } else if (expected.provenance) {
    ({ sha256: digest, bytes } = expected.provenance);
    kind = "current-page";
  } else {
    const content = Buffer.from(expected.content);
    digest = createHash("sha256").update(content).digest("hex");
    bytes = content.length;
    kind = "walk-bytes";
  }

  let handle;
  try {
    handle = await open(from, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || (bytes != null && info.size !== bytes))
      return { kind: "refused", why: CHANGED };
    bytes ??= info.size;
    const hash = createHash("sha256");
    const chunk = Buffer.alloc(65536);
    let observed = 0;
    for (;;) {
      const { bytesRead } = await handle.read(
        chunk,
        0,
        Math.min(chunk.length, bytes - observed + 1),
        observed,
      );
      if (!bytesRead) break;
      observed += bytesRead;
      if (observed > bytes) return { kind: "refused", why: CHANGED };
      hash.update(chunk.subarray(0, bytesRead));
    }
    if (observed !== bytes || hash.digest("hex") !== digest)
      return { kind: "refused", why: CHANGED };
    return { kind: "eligible", proof: { kind, sha256: digest, bytes } };
  } catch (error) {
    return {
      kind: "refused",
      why: `Source could not be safely proved (${error.code}). Inspect the file and its permissions before retrying.`,
    };
  } finally {
    await handle?.close();
  }
}

function said(each, destination) {
  return {
    file: each.file,
    trail: each.trail,
    from: relative(destination, each.from),
    to: relative(destination, each.to),
  };
}

// A refused course is beside the courses rather than among them, exactly as `verify` reports one
// (ADR-0005): it was never read, so it has nothing to renumber and no row like the others.
export function renumberReport(courses, refused = []) {
  const blocked = total(courses, "blocked");
  const recoveries = total(courses, "recoveries");
  return {
    renamed: total(courses, "renamed"),
    kept: total(courses, "kept"),
    ...(blocked ? { blocked } : {}),
    ...(recoveries ? { recoveries } : {}),
    courses,
    ...(refused.length ? { refused } : {}),
  };
}

function total(courses, field) {
  return courses.reduce((running, course) => running + (course[field]?.length ?? 0), 0);
}
