import { Buffer } from "node:buffer";
import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";
import { IMPORT_STATUS_FILENAME, isValidImportStatus } from "../sync/import-status.mjs";
import { searchMaterials } from "./search.mjs";
import { libraryHtml } from "./html.mjs";

/**
 * @typedef {{course: string, path: string, name: string, url: string} &
 *   ({kind: "markdown", text: {state: "read", value: string} | {state: "omitted", reason: string}} |
 *   {kind: "attachment", text: {state: "filename-only"}})} Material
 * @typedef {{state: "missing" | "invalid" | "unavailable", stale: null, action: string} |
 *   {state: "running" | "complete" | "partial" | "failed", stale: boolean,
 *   action: string | null, value: object}} ReceiptEvidence
 * @typedef {{key: string, scan: "complete" | "partial" | "unavailable", receipt: ReceiptEvidence, counts: object,
 *   exclusions: object, diagnostics: object[], suppressedDiagnostics: number}} CourseObservation
 * @typedef {{schemaVersion: 1, command: "library", status: "complete" | "partial" | "blocked", exitCode: number,
 *   observedAt: string, limits: object, courses: CourseObservation[], materials: Material[],
 *   diagnostics: object[], scope: string, query: string}} Catalogue
 */

export const LIBRARY_LIMITS = Object.freeze({
  courses: 128,
  entriesPerDirectory: 512,
  entries: 10000,
  directories: 1000,
  depth: 16,
  materials: 5000,
  markdownBytes: 256 * 1024,
  textBytes: 8 * 1024 * 1024,
  receiptBytes: 16 * 1024,
  diagnosticsPerCourse: 100,
  queryCodePoints: 256,
});
const STALE_AFTER_MS = 48 * 60 * 60 * 1000;
const INSPECT = "Inspect the local folder and its permissions, then rerun library.";
const BOUNDS = "Select one course, or inspect the omitted local material separately.";
const RECEIPT_ACTION = "Owner: inspect the local receipt before authorizing a live sync.";

export async function localLibrary(config, { course = "", query = "", format = "json" } = {}) {
  const catalogue = emptyCatalogue(query);
  const selected = course
    ? config.courses.filter((entry) => entry.key.toLowerCase() === course.toLowerCase())
    : config.courses;
  if (!selected.length && course)
    return libraryFailure(
      "UNKNOWN_COURSE",
      "No configured course matches that key.",
      "Run: npm run library",
      format,
    );
  if (selected.length > LIBRARY_LIMITS.courses)
    return libraryFailure(
      "COURSE_LIMIT",
      "Too many configured courses for one catalogue.",
      "Run: npm run library -- --course <key>",
      format,
    );
  if (!(constants.O_NOFOLLOW > 0) || !(constants.O_NONBLOCK > 0))
    return libraryFailure(
      "PLATFORM_UNSUPPORTED",
      "Safe local file opens are unavailable.",
      "Run library on a platform with O_NOFOLLOW and O_NONBLOCK.",
      format,
    );
  let runtime;
  try {
    runtime = await Promise.all([config.profilePath, dirname(config.statePath)].map(boundary));
    for (const entry of selected) {
      const destination = await boundary(entry.destination);
      if (runtime.some((path) => overlaps(destination, path)))
        return libraryFailure(
          "RUNTIME_OVERLAP",
          "A destination overlaps a private profile or state runtime tree.",
          "Give course destinations and private runtime separate, non-nested directories.",
          format,
        );
    }
  } catch {
    return libraryFailure(
      "BOUNDARY_UNAVAILABLE",
      "The configured directory boundaries cannot be resolved safely.",
      INSPECT,
      format,
    );
  }
  const budget = { entries: 0, directories: 0, materials: 0, textBytes: 0 };
  for (const entry of [...selected].sort((a, b) =>
    compare(a.key.toLowerCase(), b.key.toLowerCase()),
  ))
    await observeCourse(entry, catalogue, budget, runtime);
  catalogue.status = catalogue.courses.some((entry) => entry.scan !== "complete")
    ? "partial"
    : "complete";
  catalogue.exitCode = catalogue.status === "complete" ? 0 : 1;
  return output(catalogue, format);
}

export function libraryFailure(code, message, action, format = "json") {
  const catalogue = emptyCatalogue("");
  catalogue.status = "blocked";
  catalogue.exitCode = 2;
  catalogue.diagnostics.push({ code, message, action });
  return output(catalogue, format);
}

function emptyCatalogue(query) {
  return {
    schemaVersion: 1,
    command: "library",
    status: "complete",
    exitCode: 0,
    observedAt: new Date().toISOString(),
    scope:
      "local-only; no upstream completeness, current source revision, or attachment content claim",
    evidence: {
      scope: "local-filesystem-observation",
      upstreamCompleteness: "unverified",
      currentSourceRevision: "unverified",
      attachmentContents: "unread",
    },
    receiptStaleAfterMs: STALE_AFTER_MS,
    query,
    limits: LIBRARY_LIMITS,
    courses: [],
    materials: [],
    diagnostics: [],
  };
}

function output(catalogue, format) {
  if (format === "html") return { source: libraryHtml(catalogue), exitCode: catalogue.exitCode };
  const results = searchMaterials(catalogue.materials, catalogue.query);
  return {
    source: JSON.stringify(
      {
        ...catalogue,
        materialCount: catalogue.materials.length,
        matchCount: results.length,
        materials: results.map(({ text, ...material }) => ({
          ...material,
          text: text.state === "read" ? { state: "read" } : text,
        })),
      },
      null,
      2,
    ),
    exitCode: catalogue.exitCode,
  };
}

async function observeCourse(entry, catalogue, budget, runtime) {
  const course = {
    key: entry.key,
    scan: "complete",
    receipt: { state: "unavailable", stale: null, action: RECEIPT_ACTION },
    counts: { markdown: 0, attachments: 0 },
    exclusions: { hidden: 0, provenance: 0, operational: 0, temporary: 0, symlink: 0, special: 0 },
    diagnostics: [],
    suppressedDiagnostics: 0,
  };
  catalogue.courses.push(course);
  try {
    const root = await realpath(entry.destination);
    const info = await lstat(root);
    if (!info.isDirectory()) throw refusal("DESTINATION_UNAVAILABLE");
    const rootBoundary = { lexical: resolve(entry.destination), canonical: root };
    if (runtime.some((path) => overlaps(rootBoundary, path))) throw refusal("OBSERVED_CHANGE");
    const ancestors = [{ path: root, info }];
    const guard = async (parents) => {
      if ((await realpath(entry.destination)) !== root) throw refusal("OBSERVED_CHANGE");
      for (const parent of parents) {
        const current = await lstat(parent.path);
        if (!current.isDirectory() || !sameFile(parent.info, current))
          throw refusal("OBSERVED_CHANGE");
      }
    };
    course.receipt = await receiptEvidence(root, ancestors, guard, catalogue.observedAt);
    await visit(root, "", ancestors, 0);
    await guard(ancestors);

    async function visit(directory, prefix, parents, depth) {
      if (depth > LIBRARY_LIMITS.depth || budget.directories >= LIBRARY_LIMITS.directories) {
        diagnostic(course, "DIRECTORY_LIMIT", prefix, BOUNDS);
        return;
      }
      budget.directories += 1;
      let names;
      try {
        await guard(parents);
        names = await directoryNames(directory, budget);
        await guard(parents);
      } catch (error) {
        diagnostic(
          course,
          error.libraryCode ?? "DIRECTORY_UNREADABLE",
          prefix,
          ["DIRECTORY_SIZE", "ENTRY_LIMIT"].includes(error.libraryCode) ? BOUNDS : INSPECT,
        );
        return;
      }
      for (const name of names) {
        if (budget.materials >= LIBRARY_LIMITS.materials) {
          diagnostic(course, "CATALOGUE_LIMIT", prefix, BOUNDS);
          return;
        }
        const path = join(directory, name);
        const localPath = prefix ? `${prefix}/${name}` : name;
        const excluded = exclusion(name, depth);
        if (excluded) {
          course.exclusions[excluded] += 1;
          continue;
        }
        try {
          await guard(parents);
          const info = await lstat(path);
          if (info.isSymbolicLink()) {
            course.exclusions.symlink += 1;
            continue;
          }
          if (info.isDirectory()) {
            await visit(path, localPath, [...parents, { path, info }], depth + 1);
            continue;
          }
          if (!info.isFile()) {
            course.exclusions.special += 1;
            continue;
          }
          const markdown = name.toLowerCase().endsWith(".md");
          const material = {
            course: entry.key,
            path: localPath,
            name,
            url: pathToFileURL(path).href,
            kind: markdown ? "markdown" : "attachment",
            text: { state: "filename-only" },
          };
          if (markdown) {
            try {
              if (
                info.size > LIBRARY_LIMITS.markdownBytes ||
                budget.textBytes + info.size > LIBRARY_LIMITS.textBytes
              )
                throw refusal("TEXT_LIMIT");
              const bytes = await boundedRead(
                path,
                info,
                LIBRARY_LIMITS.markdownBytes,
                parents,
                guard,
              );
              budget.textBytes += bytes.length;
              material.text = {
                state: "read",
                value: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
              };
            } catch (error) {
              const reason = error.libraryCode ?? "TEXT_UNREADABLE";
              material.text = { state: "omitted", reason };
              diagnostic(course, reason, localPath, reason === "TEXT_LIMIT" ? BOUNDS : INSPECT);
            }
          }
          await guard(parents);
          const current = await lstat(path);
          if (!sameFile(info, current)) throw refusal("OBSERVED_CHANGE");
          catalogue.materials.push(material);
          budget.materials += 1;
          course.counts[markdown ? "markdown" : "attachments"] += 1;
        } catch (error) {
          diagnostic(course, error.libraryCode ?? "ENTRY_UNREADABLE", localPath, INSPECT);
        }
      }
    }
  } catch (error) {
    course.scan = "unavailable";
    diagnostic(course, error.libraryCode ?? "DESTINATION_UNAVAILABLE", "", INSPECT);
  }
}

async function directoryNames(path, budget) {
  const directory = await opendir(path);
  const names = [];
  try {
    for await (const entry of directory) {
      if (budget.entries >= LIBRARY_LIMITS.entries) throw refusal("ENTRY_LIMIT");
      budget.entries += 1;
      if (names.length === LIBRARY_LIMITS.entriesPerDirectory) throw refusal("DIRECTORY_SIZE");
      names.push(entry.name);
    }
  } finally {
    await directory.close().catch((error) => {
      if (error.code !== "ERR_DIR_CLOSED") throw error;
    });
  }
  return names.sort(compare);
}

async function boundedRead(path, expected, maximum, parents, guard) {
  await guard(parents);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || !sameFile(expected, info)) throw refusal("OBSERVED_CHANGE");
    if (info.size > maximum) throw refusal("TEXT_LIMIT");
    const bytes = Buffer.alloc(Math.min(info.size + 1, maximum + 1));
    let length = 0;
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, null);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length !== info.size || !sameFile(info, await handle.stat()))
      throw refusal("OBSERVED_CHANGE");
    await guard(parents);
    if (!sameFile(info, await lstat(path))) throw refusal("OBSERVED_CHANGE");
    return bytes.subarray(0, length);
  } finally {
    await handle.close();
  }
}

async function receiptEvidence(root, parents, guard, observedAt) {
  try {
    const path = join(root, IMPORT_STATUS_FILENAME);
    const info = await lstat(path);
    if (!info.isFile() || info.size > LIBRARY_LIMITS.receiptBytes) throw refusal("RECEIPT_INVALID");
    const bytes = await boundedRead(path, info, LIBRARY_LIMITS.receiptBytes, parents, guard);
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!isValidImportStatus(value, observedAt)) throw refusal("RECEIPT_INVALID");
    const stale =
      Date.parse(observedAt) - Date.parse(value.finishedAt ?? value.startedAt) > STALE_AFTER_MS;
    return {
      state: value.status,
      stale,
      action: stale || value.status !== "complete" ? RECEIPT_ACTION : null,
      value,
    };
  } catch (error) {
    return {
      state: error.code === "ENOENT" ? "missing" : "invalid",
      stale: null,
      action: RECEIPT_ACTION,
    };
  }
}

function exclusion(name, depth) {
  if (name.startsWith(".")) return "hidden";
  if (depth === 0 && name.toLowerCase() === "source editions") return "provenance";
  if (["last synced.md", IMPORT_STATUS_FILENAME.toLowerCase()].includes(name.toLowerCase()))
    return "operational";
  if (/\.(?:part|partial|tmp)(?:-|$)/i.test(name)) return "temporary";
  return null;
}

function diagnostic(course, code, path, action) {
  if (course.scan === "complete") course.scan = "partial";
  if (course.diagnostics.length >= LIBRARY_LIMITS.diagnosticsPerCourse)
    course.suppressedDiagnostics += 1;
  else course.diagnostics.push({ code, path, action });
}

function sameFile(a, b) {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.mode === b.mode &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs
  );
}

async function boundary(path) {
  const lexical = resolve(path);
  let ancestor = lexical;
  while (true) {
    try {
      return { lexical, canonical: resolve(await realpath(ancestor), relative(ancestor, lexical)) };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
}

function overlaps(a, b) {
  return [a.lexical, a.canonical].some((left) =>
    [b.lexical, b.canonical].some((right) => {
      left = left.toLowerCase();
      right = right.toLowerCase();
      return (
        left === right ||
        left.startsWith(right.endsWith(sep) ? right : `${right}${sep}`) ||
        right.startsWith(left.endsWith(sep) ? left : `${left}${sep}`)
      );
    }),
  );
}

function compare(a, b) {
  const left = Array.from(a, (character) => character.codePointAt(0));
  const right = Array.from(b, (character) => character.codePointAt(0));
  for (let index = 0; index < Math.min(left.length, right.length); index += 1)
    if (left[index] !== right[index]) return left[index] - right[index];
  return left.length - right.length;
}
function refusal(code) {
  return Object.assign(new Error(code), { libraryCode: code });
}
