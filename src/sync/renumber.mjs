import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { expectedFiles } from "./expected.mjs";
import { fileDigest, isFilePresent, moveDirectory, readText, relinkFile } from "./files.mjs";
import { numberingOf } from "./numbering.mjs";
import { assertDestinationPath, safeSegment, unnumbered } from "./paths.mjs";
import { attachmentStateKey, resolveSourceEditions } from "./source-editions.mjs";
import { courseState } from "./state.mjs";

// Why something the numbering has moved was left where it is. Said in the report rather than
// counted, because each is a different fact about the destination and only the first is ordinary.
const CHANGED = "it has changed since the sync wrote it";
const UNRECORDED = "no recorded digest, so there is nothing to hold it against";
const TAKEN = "the name it wants is held by something else";
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

// Putting a destination back into the order NTULearn gives the course today. A sync never renames
// (ADR-0003) and #70 left the numbering alone on purpose, so a course reordered upstream keeps the
// order its files arrived in — permanently, with nothing that puts it back. This is that something,
// and it is a command of its own rather than a phase of a sync, because a rename is a delete and a
// create to anything holding a path and belongs nowhere near an unattended run (ADR-0010).
//
// Source selection does not grant move permission. Attachments still require State, and current
// recorded pages require both the rendered revision and complete accepted bytes (ADR-0029).
export async function renumberCourse({ client, course, state }) {
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
    // Only ever the number in front of the name: the new name is made inside the directory the
    // thing is already in, so nothing moves between folders and a folder whose own number has not
    // been corrected yet is no obstacle to correcting the names underneath it.
    const currentPrefix = segments.at(-1).match(/^\d+ /)?.[0];
    const leaf = currentPrefix ? basename(from).replace(/^\d+ /, currentPrefix) : basename(from);
    const to = join(dirname(from), safeSegment(leaf));
    // Which is also why a file can be at a path that has moved while its own name is already
    // right: the folder above it is the thing that moved, and that folder's own rename carries it.
    if (to === from) continue;

    const why = await unproven(expected, from, previous);
    if (why) kept.push({ ...named, path: at, onDisk: relative(course.destination, from), why });
    else moving.push({ ...named, kind: expected.kind, depth: segments.length, from, to });
  }

  const renamed = [];
  const blocked = [];
  // Files first, then folders from the deepest up, because a `from` path is read before any of this
  // and renaming a folder first would invalidate every path beneath it.
  await take(files(moving), renamed, blocked);
  await take(folders(moving), renamed, blocked);
  const movedFolders = renamed.filter((each) => each.kind === "folder");
  for (const each of kept)
    if (each.onDisk)
      each.onDisk = relative(
        course.destination,
        afterFolders(resolve(course.destination, each.onDisk), movedFolders),
      );

  return {
    key: course.key,
    course: snapshot.course.displayName,
    destination: course.destination,
    renamed: renamed.map((each) => said(each, course.destination, movedFolders)),
    // A file the student annotated is one this command exists to leave alone, so `kept` is an
    // ordinary outcome; only a name it could not free is a run with something wrong with it.
    ...(kept.length ? { kept } : {}),
    ...(blocked.length
      ? {
          blocked: blocked.map((each) => ({
            ...said(each, course.destination, movedFolders),
            why: TAKEN,
          })),
        }
      : {}),
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

// The evidence, or the reason there is none. A destination is somebody's own folder and a rename
// reaches whatever they have done with the file since — annotated it, linked it from their notes —
// so this asks the narrow question "are these still the bytes the sync wrote", and every answer but
// yes leaves the file alone. It is ADR-0003's objection answered rather than argued with: the record
// says what this repository wrote, and a digest is what says nothing has happened to it since.
async function unproven(expected, from, previous) {
  // A folder holds no bytes to hold against anything. What is renamed is a directory this
  // repository created and named, and everything inside it moves with it intact (ADR-0010).
  if (expected.kind === "folder") return null;
  if (expected.kind !== "attachment") {
    if (expected.provenance)
      return (await isFilePresent(from, expected.provenance.bytes)) &&
        (await fileDigest(from)) === expected.provenance.sha256
        ? null
        : CHANGED;
    return (await readText(from)) === expected.content ? null : CHANGED;
  }

  const record =
    previous.downloads?.[attachmentStateKey(expected.attachment)] ??
    previous.downloads?.[expected.attachment.resourceUrl];
  if (!/^[a-f0-9]{64}$/.test(record?.sha256 ?? "")) return UNRECORDED;
  if (
    (record.sourceIdentity != null && record.sourceIdentity !== expected.source.identity) ||
    (expected.provenance && record.sha256 !== expected.provenance.sha256)
  )
    return STATE_CONFLICT;
  if (expected.provenance && !(await isFilePresent(from, expected.provenance.bytes)))
    return CHANGED;
  return (await fileDigest(from)) === record.sha256 ? null : CHANGED;
}

function files(moving) {
  return moving.filter((each) => each.kind !== "folder");
}

function folders(moving) {
  return moving.filter((each) => each.kind === "folder").sort((a, b) => b.depth - a.depth);
}

async function take(moving, renamed, blocked) {
  for (const each of moving) {
    const took =
      each.kind === "folder"
        ? await moveDirectory(each.from, each.to)
        : await relinkFile(each.from, each.to);
    if (took) renamed.push(each);
    else blocked.push(each);
  }
}

// Where it was when the command started and where it is when the command finishes — which is not
// the rename this line performed, for anything under a folder that is itself renamed afterwards.
// The pair a reader wants is the one that lets them find the file, and that is the outer one.
function said(each, destination, movedFolders) {
  return {
    file: each.file,
    trail: each.trail,
    from: relative(destination, each.from),
    to: relative(destination, afterFolders(each.to, movedFolders)),
  };
}

function afterFolders(path, movedFolders) {
  for (const folder of movedFolders)
    if (path === folder.from || path.startsWith(folder.from + sep))
      path = join(folder.to, relative(folder.from, path));
  return path;
}

// A refused course is beside the courses rather than among them, exactly as `verify` reports one
// (ADR-0005): it was never read, so it has nothing to renumber and no row like the others.
export function renumberReport(courses, refused = []) {
  const blocked = total(courses, "blocked");
  return {
    renamed: total(courses, "renamed"),
    kept: total(courses, "kept"),
    ...(blocked ? { blocked } : {}),
    courses,
    ...(refused.length ? { refused } : {}),
  };
}

function total(courses, field) {
  return courses.reduce((running, course) => running + (course[field]?.length ?? 0), 0);
}
