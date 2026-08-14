import { dirname, join, relative, resolve } from "node:path";
import { expectedFiles } from "./expected.mjs";
import { fileDigest, moveDirectory, readText, relinkFile } from "./files.mjs";
import { numberingOf } from "./numbering.mjs";
import { safeResolve, safeSegment, unnumbered } from "./paths.mjs";
import { courseState } from "./state.mjs";

// Why something the numbering has moved was left where it is. Said in the report rather than
// counted, because each is a different fact about the destination and only the first is ordinary.
const CHANGED = "it has changed since the sync wrote it";
const UNRECORDED = "no recorded digest, so there is nothing to hold it against";
const TAKEN = "the name it wants is held by something else";

// Putting a destination back into the order NTULearn gives the course today. A sync never renames
// (ADR-0003) and #70 left the numbering alone on purpose, so a course reordered upstream keeps the
// order its files arrived in — permanently, with nothing that puts it back. This is that something,
// and it is a command of its own rather than a phase of a sync, because a rename is a delete and a
// create to anything holding a path and belongs nowhere near an unattended run (ADR-0010).
//
// It renames only what it can prove the sync wrote and nothing has touched since: the digest a
// download recorded, or, for a document, the text this very walk produced. Everything else is left
// exactly where it is and named in the report. Nothing is deleted and no name is written over.
export async function renumberCourse({ client, course, state }) {
  const snapshot = await client.readCourse(course.courseId);
  const previous = courseState(state, course.key);

  const walked = [];
  for await (const expected of expectedFiles({ client, courseId: course.courseId, snapshot })) {
    walked.push(expected);
  }
  const numbering = numberingOf(
    course.destination,
    walked.map((expected) => expected.placement.segments),
  );

  const moving = [];
  const kept = [];
  for (const expected of walked) {
    const from = await heldAt(numbering, course.destination, expected);
    if (from === null) continue;

    const { file, trail, path, segments } = expected.placement;
    // Only ever the number in front of the name: the new name is made inside the directory the
    // thing is already in, so nothing moves between folders and a folder whose own number has not
    // been corrected yet is no obstacle to correcting the names underneath it.
    const to = join(dirname(from), safeSegment(segments.at(-1)));
    // Which is also why a file can be at a path that has moved while its own name is already
    // right: the folder above it is the thing that moved, and that folder's own rename carries it.
    if (to === from) continue;

    // A folder is placed rather than filed, so it has no `file` or `path` of its own — its name is
    // the last of its segments and its title is that name without the number (`placement.mjs`).
    const named = { file: file ?? unnumbered(segments.at(-1)), trail };
    const at = path ?? segments.join("/");
    const why = await unproven(expected, from, previous);
    if (why) kept.push({ ...named, path: at, onDisk: relative(course.destination, from), why });
    else moving.push({ ...named, kind: expected.kind, depth: segments.length, from, to, at });
  }

  const renamed = [];
  const blocked = [];
  // Files first, then folders from the deepest up, because a `from` path is read before any of this
  // and renaming a folder first would invalidate every path beneath it.
  await take(files(moving), renamed, blocked, course.destination);
  await take(folders(moving), renamed, blocked, course.destination);

  return {
    key: course.key,
    course: snapshot.course.displayName,
    destination: course.destination,
    renamed,
    // A file the student annotated is one this command exists to leave alone, so `kept` is an
    // ordinary outcome; only a name it could not free is a run with something wrong with it.
    ...(kept.length ? { kept } : {}),
    ...(blocked.length ? { blocked } : {}),
  };
}

// Where the destination holds this file or folder when that is not the name the course gives it
// today, and `null` when there is nothing to do. The lookup is the one a sync and `verify` share
// (ADR-0009), so all three agree about which thing on disk is which item's.
async function heldAt(numbering, destination, expected) {
  const { segments } = expected.placement;
  const found =
    expected.kind === "folder"
      ? await numbering.directory(segments)
      : await numbering.find(segments);
  if (found === null) return null;
  const from = resolve(destination, found);
  return from === safeResolve(destination, ...segments) ? null : from;
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
  // A document is a pure function of the snapshot, so the walk is already holding what the sync
  // would write and no record is needed to check it against.
  if (expected.kind !== "attachment") {
    return (await readText(from)) === expected.content ? null : CHANGED;
  }

  const record = previous.downloads?.[expected.attachment.resourceUrl];
  if (!record?.sha256) return UNRECORDED;
  return (await fileDigest(from)) === record.sha256 ? null : CHANGED;
}

function files(moving) {
  return moving.filter((each) => each.kind !== "folder");
}

function folders(moving) {
  return moving.filter((each) => each.kind === "folder").sort((a, b) => b.depth - a.depth);
}

// One pass, in any order, and no name a rename produces is a name another is waiting for. That is
// worth stating because the shifting it does looks exactly like the problem where it is not true.
//
// A file is here only because the walk found it under a name that is *not* the one the course gives
// it today — which is to say the name it wants held no file when this run looked. Two items cannot
// want one name either, since a name is a folder and a title and the walk yields each item once. So
// no rename waits on another, and there is no cycle to break with a temporary name — which matters,
// because a temporary name is one nothing recognises if the run dies holding it.
//
// What is left is a name holding something the walk did not account for: a directory, most likely
// the empty one a reorder left beside its folder before #70. It is reported and nothing else.
async function take(moving, renamed, blocked, destination) {
  for (const each of moving) {
    const took =
      each.kind === "folder"
        ? await moveDirectory(each.from, each.to)
        : await relinkFile(each.from, each.to);
    if (took) renamed.push(said(each, destination));
    else blocked.push({ ...said(each, destination), why: TAKEN });
  }
}

// Where it was when the command started and where it is when the command finishes — which is not
// the rename this line performed, for anything under a folder that is itself renamed afterwards.
// The pair a reader wants is the one that lets them find the file, and that is the outer one.
function said(each, destination) {
  return {
    file: each.file,
    trail: each.trail,
    from: relative(destination, each.from),
    to: each.at,
  };
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
