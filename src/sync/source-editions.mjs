import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, sep } from "node:path";
import { ambiguousPaths, comparablePath } from "./expected.mjs";
import { fileDigest, isFilePresent } from "./files.mjs";
import { assertDestinationPath, safeSegment } from "./paths.mjs";
import { numberingOf } from "./numbering.mjs";
import { provenanceRecords } from "./source-provenance.mjs";

const DIGEST = /^[a-f0-9]{64}$/;
const NONREGULAR = Symbol("nonregular source placement");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const identityValue = (value) =>
  typeof value === "string" && value.trim() && value.length <= 4096 ? value : null;

export function sourceIdentity(expected) {
  if (expected.announcement)
    return identityValue(expected.announcement.id)
      ? hash(JSON.stringify(["announcement", expected.announcement.id]))
      : null;
  if (expected.kind === "document" && expected.item)
    return identityValue(expected.item.id)
      ? hash(JSON.stringify(["page", expected.item.id]))
      : null;
  if (expected.kind !== "attachment" || !identityValue(expected.item?.id)) return null;
  const attachment = expected.attachment;
  if (!identityValue(attachment?.resourceUrl)) return null;
  let id = identityValue(attachment?.id) || identityValue(attachment?.fileId);
  if (!id) {
    try {
      const address = new URL(attachment.resourceUrl, "https://ntulearn.ntu.edu.sg");
      if (!["https:", "http:"].includes(address.protocol) || address.username || address.password)
        return null;
      const xid = address.pathname.match(/xid-[A-Za-z0-9_]+/i)?.[0]?.toLowerCase();
      if (xid) id = "xid:" + xid;
      else if (
        !address.search &&
        !address.hash &&
        address.pathname !== "/" &&
        !/\/(?:ks|session|token)\//i.test(address.pathname)
      )
        id = "path:" + address.origin + address.pathname;
    } catch {
      return null;
    }
  }
  return id ? hash(JSON.stringify(["attachment", expected.item.id, id])) : null;
}

export function attachmentStateKey(attachment) {
  const address = String(attachment.resourceUrl ?? "");
  let secret = /[?#]|\/(?:ks|%6bs|k%73|%6b%73|session|token)\//i.test(address);
  try {
    const url = new URL(address, "https://ntulearn.ntu.edu.sg");
    secret ||= Boolean(url.username || url.password);
  } catch {}
  return secret ? "source:" + hash(address) : address;
}
export function attachmentFingerprint(item, attachment, { legacy = false } = {}) {
  if (legacy)
    return `${item.modifiedDate ?? ""}:${attachment.fileSize ?? ""}:${attachment.resourceUrl}`;
  return hash(
    JSON.stringify([
      item.modifiedDate ?? null,
      attachment.fileSize ?? null,
      attachmentStateKey(attachment),
    ]),
  );
}

export async function resolveSourceEditions({
  walked,
  destination,
  previous = {},
  verify = false,
  loadAttachment,
}) {
  const ambiguous = ambiguousPaths(walked),
    identities = new Map();
  for (const expected of walked) {
    const id = sourceIdentity(expected);
    if (id) identities.set(id, (identities.get(id) ?? 0) + 1);
  }
  const numbering = numberingOf(
    destination,
    walked.map((each) => each.placement.segments),
  );
  const resolved = [];
  for (const expected of walked) {
    if (expected.kind !== "attachment" && !expected.announcement && !expected.item) {
      resolved.push(expected);
      continue;
    }
    const sourceIdentityValue = sourceIdentity(expected),
      colliding = ambiguous.has(comparablePath(expected.placement));
    if (!sourceIdentityValue || identities.get(sourceIdentityValue) > 1) {
      resolved.push({ ...expected, sourceFailure: "SOURCE_IDENTITY_UNRESOLVED" });
      continue;
    }
    const source = {
      identity: sourceIdentityValue,
      kind:
        expected.kind === "attachment"
          ? "attachment"
          : expected.announcement
            ? "announcement"
            : "page",
      version: expected.kind === "attachment" ? null : hash(expected.content),
      ...(expected.kind === "attachment"
        ? { fingerprint: attachmentFingerprint(expected.item, expected.attachment) }
        : {}),
    };
    const history = await provenanceRecords(destination, source);
    const old =
      expected.kind === "attachment"
        ? (previous.downloads?.[attachmentStateKey(expected.attachment)] ??
          previous.downloads?.[expected.attachment.resourceUrl])
        : null;
    let fetchedRevision = false;
    let retainedPath = null;
    let retainedDigest = null;
    let statePath = null;
    let records = history.filter((r) => r.version === source.version);
    if (source.kind === "attachment") {
      if (!history.length && !colliding) {
        retainedPath = await numbering.find(expected.placement.segments);
        if (retainedPath) {
          const target = join(destination, retainedPath);
          await assertDestinationPath(destination, target);
          retainedDigest = await regularDigest(target);
          if (retainedDigest === NONREGULAR) {
            resolved.push({ ...expected, sourceFailure: "SOURCE_PUBLICATION_CONFLICT" });
            continue;
          }
        } else {
          const parentSegments = expected.placement.segments.slice(0, -1);
          const parent =
            (parentSegments.length ? await numbering.directory(parentSegments) : null) ??
            parentSegments.join(sep);
          const target = join(destination, parent, expected.placement.segments.at(-1));
          await assertDestinationPath(destination, target);
          if ((await regularDigest(target)) === NONREGULAR) {
            resolved.push({ ...expected, sourceFailure: "SOURCE_PUBLICATION_CONFLICT" });
            continue;
          }
        }
      }
      records = history.filter(
        (r) => r.schemaVersion === 2 && r.fingerprint === source.fingerprint,
      );
      if (new Set(records.map((r) => r.version)).size > 1) {
        resolved.push({ ...expected, sourceFailure: "SOURCE_REVISION_UNRESOLVED" });
        continue;
      }
      if (!records.length && !verify) {
        const legacy = history.find(
          (r) =>
            r.schemaVersion === 1 &&
            r.relativePath === old?.relativePath &&
            r.sha256 === old?.sha256 &&
            (old?.sourceIdentity === source.identity || !old?.sourceIdentity) &&
            (old?.fingerprint === source.fingerprint ||
              old?.fingerprint ===
                attachmentFingerprint(expected.item, expected.attachment, { legacy: true })) &&
            Number.isSafeInteger(old?.bytes) &&
            old.bytes >= 0,
        );
        if (legacy) {
          const path = join(destination, legacy.relativePath);
          await assertDestinationPath(destination, path);
          const digest = await regularDigest(path);
          if (digest === NONREGULAR) {
            resolved.push({ ...expected, sourceFailure: "SOURCE_PUBLICATION_CONFLICT" });
            continue;
          }
          if (digest === legacy.sha256) records = [legacy];
        }
        if (
          !records.length &&
          !history.length &&
          (old?.fingerprint === source.fingerprint ||
            old?.fingerprint ===
              attachmentFingerprint(expected.item, expected.attachment, { legacy: true })) &&
          (old?.sourceIdentity === source.identity || !old?.sourceIdentity) &&
          DIGEST.test(old?.sha256 ?? "") &&
          validPath(old?.relativePath) &&
          Number.isSafeInteger(old?.bytes) &&
          old.bytes >= 0
        ) {
          const path = join(destination, old.relativePath);
          await assertDestinationPath(destination, path);
          const actual = await regularDigest(path);
          if (actual === NONREGULAR) {
            resolved.push({ ...expected, sourceFailure: "SOURCE_PUBLICATION_CONFLICT" });
            continue;
          }
          if (actual === old.sha256) {
            statePath = old.relativePath;
            source.version = old.sha256;
          } else if (actual !== null) {
            resolved.push({ ...expected, sourceFailure: "SOURCE_PUBLICATION_CONFLICT" });
            continue;
          }
        }
        if (!records.length && !statePath && (history.length || retainedDigest !== null)) {
          try {
            const downloaded = await loadAttachment(expected.attachment);
            source.version = hash(downloaded.body);
            fetchedRevision = true;
            records = history.filter((r) => r.sha256 === source.version);
          } catch (error) {
            resolved.push({
              ...expected,
              sourceFailure: "SOURCE_FETCH_FAILED",
              sourceError: /not signed in while downloading|http 401/i.test(error.message)
                ? "Not signed in while downloading the current source revision. Run: npm run login"
                : "Current source revision could not be fetched. Retry sync; if it repeats, report an ntulearn defect.",
            });
            continue;
          }
        }
      }
      if (records.length) source.version = records[0].sha256;
      if (verify && history.length && !records.length) {
        resolved.push({ ...expected, sourceFailure: "SOURCE_REVISION_UNRESOLVED" });
        continue;
      }
    }
    source.originalPath = history.length
      ? history[0].originalPath
      : (statePath ?? retainedPath ?? expected.placement.path);
    const paths = [...new Set(records.map((record) => record.relativePath))],
      present = [];
    for (const path of paths) {
      const target = join(destination, path);
      await assertDestinationPath(destination, target);
      if (await isFilePresent(target)) present.push(path);
    }
    if (present.length > 1 || (paths.length > 1 && !present.length)) {
      resolved.push({ ...expected, sourceFailure: "SOURCE_PLACEMENT_AMBIGUOUS" });
      continue;
    }
    const provenance =
      records.find((record) => record.relativePath === (present[0] ?? paths[0])) ?? null;
    let placement = expected.placement,
      sourcePath;
    if (provenance) {
      sourcePath = provenance.relativePath;
      if (!present.length) {
        const leaf = provenance.relativePath.split(sep).at(-1);
        const currentPrefix = expected.placement.segments.at(-1).match(/^\d+ /)?.[0] ?? "";
        const probe = leaf.includes("[source ")
          ? [...expected.placement.segments.slice(0, -1), leaf.replace(/^\d+ /, currentPrefix)]
          : expected.placement.segments;
        sourcePath = (await numbering.find(probe)) ?? sourcePath;
      }
      if (provenance.relativePath.split(sep).at(-1).includes("[source "))
        placement = atPath(
          placement,
          [...placement.segments.slice(0, -1), provenance.relativePath.split(sep).at(-1)].join(sep),
        );
    } else if (expected.kind === "attachment") {
      if (fetchedRevision && (history.length || retainedDigest !== source.version))
        placement = suffixed(
          placement,
          `source ${source.identity} revision ${source.version.slice(0, 24)}`,
        );
      else if (statePath) sourcePath = statePath;
      else if (fetchedRevision && retainedDigest === source.version) sourcePath = retainedPath;
      else if (colliding && !fetchedRevision)
        placement = suffixed(placement, `source ${source.identity}`);
    } else {
      const retained =
        history.length || colliding ? null : await numbering.find(placement.segments);
      if (retained) source.originalPath = retained;
      const path = join(destination, retained ?? placement.path);
      await assertDestinationPath(destination, path);
      const current = verify ? null : await regularDigest(path);
      if (current === NONREGULAR) {
        resolved.push({ ...expected, sourceFailure: "SOURCE_PUBLICATION_CONFLICT" });
        continue;
      }
      if (colliding && !history.length && current === null) source.originalPath = null;
      if (colliding || history.length || (current !== null && current !== hash(expected.content)))
        placement = suffixed(
          placement,
          `source ${source.identity} revision ${source.version.slice(0, 24)}`,
        );
    }
    let content = expected.content;
    const edition = placement.segments.at(-1).includes("[source ");
    if (source.kind !== "attachment" && edition) {
      const relationship = source.originalPath
        ? `[Retained original placement](<${relative(
            dirname(join(destination, placement.path)),
            join(destination, source.originalPath),
          )
            .split(sep)
            .map(encodeURIComponent)
            .join(
              "/",
            )}>); its ownership may be unproven, and its bytes and annotations are retained.`
        : "No original file was recorded at the legacy placement.";
      content += `\n---\n\nSource edition. ${relationship}\n`;
    }
    const path = sourcePath
      ? join(destination, sourcePath)
      : join(destination, ...placement.segments.map(safeSegment));
    await assertDestinationPath(destination, path);
    let sourceFailure;
    if (provenance && !verify) {
      const digest = await regularDigest(path);
      if (digest === NONREGULAR) {
        resolved.push({ ...expected, sourceFailure: "SOURCE_PUBLICATION_CONFLICT" });
        continue;
      }
      if (digest !== null && digest !== provenance.sha256)
        sourceFailure = "SOURCE_PUBLICATION_CONFLICT";
    }
    resolved.push({
      ...expected,
      placement,
      content,
      source,
      provenance,
      sourcePath,
      fetchedRevision,
      edition,
      ...(sourceFailure ? { sourceFailure } : {}),
    });
  }
  const destinations = new Map();
  for (const each of resolved) {
    if (each.kind === "folder") continue;
    const path = each.sourcePath ?? each.placement.path,
      key = path.toLowerCase();
    destinations.set(key, (destinations.get(key) ?? 0) + 1);
  }
  return resolved.map((each) =>
    each.kind !== "folder" &&
    destinations.get((each.sourcePath ?? each.placement.path).toLowerCase()) > 1
      ? { ...each, sourceFailure: "SOURCE_PLACEMENT_AMBIGUOUS" }
      : each,
  );
}

async function regularDigest(path) {
  const info = await lstat(path).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (info && !info.isFile()) return NONREGULAR;
  return info ? fileDigest(path) : null;
}

function validPath(path) {
  return (
    typeof path === "string" &&
    !isAbsolute(path) &&
    path.length <= 4096 &&
    path.split(sep).every((s) => s && s !== "." && s !== ".." && s === safeSegment(s))
  );
}
function atPath(placement, path) {
  return { ...placement, segments: path.split(sep), path };
}
function suffixed(placement, suffix) {
  const leaf = safeSegment(placement.segments.at(-1)),
    extension = extname(leaf);
  const maximum = 160 - Buffer.byteLength(` [${suffix}]${extension}`);
  let stem = leaf.slice(0, leaf.length - extension.length);
  while (Buffer.byteLength(stem) > maximum) stem = Array.from(stem).slice(0, -1).join("");
  if (!stem || maximum < 1)
    throw Error("Source filename is too long. Choose a shorter upstream filename before retrying.");
  return atPath(
    placement,
    [...placement.segments.slice(0, -1), `${stem} [${suffix}]${extension}`].join(sep),
  );
}
