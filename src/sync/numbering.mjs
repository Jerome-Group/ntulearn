import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { isFilePresent } from "./files.mjs";
import { safeSegment, unnumbered } from "./paths.mjs";

// Where a destination holds an expected file when the number in its name has moved.
//
// A name carries its item's position, so one item inserted upstream renumbers every later name
// while nothing on disk moves, because a sync never renames (ADR-0003). A check that only looked
// at the new name would call the whole tail of a course absent (#67), and this is what tells that
// file from one that is genuinely not there.
//
// It needs the other expected names to answer at all: a file stands in for one at another number
// only where the name inside the number is that folder's alone. Two items in a folder may share a
// title — NTULearn allows it — and then the name identifies neither, so this finds nothing rather
// than guess. What it cannot tell apart is a file left behind for an item NTULearn has stopped
// returning (ADR-0003) that carries the same title: nothing but the bytes separates the two, and
// this command never opens a file (ADR-0005).
export function numberingOf(destination, expected) {
  const tree = treeOf(expected);
  const listings = new Map();

  return {
    async find(segments) {
      const found = await locate(destination, tree, segments.map(safeSegment), listings);
      return found && relative(destination, found);
    },
  };
}

async function locate(directory, siblings, [segment, ...rest], listings) {
  for (const name of await standIns(directory, siblings, segment, listings)) {
    const path = join(directory, name);
    const found = rest.length
      ? await locate(path, siblings.get(segment), rest, listings)
      : await fileAt(path);
    if (found) return found;
  }
  return null;
}

async function fileAt(path) {
  return (await isFilePresent(path)) ? path : null;
}

async function standIns(directory, siblings, segment, listings) {
  const entries = await listing(directory, listings);
  const exact = entries.has(segment) ? [segment] : [];
  if (namedTwice(siblings, segment)) return exact;

  const name = unnumbered(segment);
  // Sorted, because a course reordered twice leaves more than one older number and a report two
  // scheduled runs are diffed against may not depend on the order a directory happens to list in.
  const moved = [...entries]
    .filter((entry) => entry !== segment && unnumbered(entry) === name)
    .sort();
  return [...exact, ...moved];
}

function namedTwice(siblings, segment) {
  const name = unnumbered(segment);
  return [...siblings.keys()].some((each) => each !== segment && unnumbered(each) === name);
}

// A directory that is not there reads as one holding nothing: `verify` looks only where NTULearn
// told it to look, so an absent destination is an absent file rather than an error of its own.
async function listing(directory, listings) {
  if (!listings.has(directory)) {
    listings.set(
      directory,
      readdir(directory).then(
        (names) => new Set(names),
        () => new Set(),
      ),
    );
  }
  return listings.get(directory);
}

// The expected names as the folders that hold them, so what a name may stand in for is decided
// among its own siblings rather than anywhere in the course.
function treeOf(expected) {
  const root = new Map();
  for (const segments of expected) {
    let node = root;
    for (const segment of segments.map(safeSegment)) {
      if (!node.has(segment)) node.set(segment, new Map());
      node = node.get(segment);
    }
  }
  return root;
}
