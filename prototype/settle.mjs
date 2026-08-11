import { dirname, resolve } from "node:path";
import { stderr, stdout } from "node:process";
import { fileURLToPath } from "node:url";
import { loadConfig, selectCourses } from "../src/config.mjs";
import { openClient } from "../src/ntulearn/client.mjs";
import { writeLine } from "../src/output.mjs";
import { expectedAttachments } from "../src/sync/attachments.mjs";
import { openSecondReader } from "./second-reader.mjs";

// Settles the question `compare.mjs` raises and cannot answer. It finds a file-shaped link the walk
// does not have, on an element that carries more than one — and `embeddedUrl` keeps exactly one URL
// per embed, so the second address is either the same file written down twice or a file nobody
// downloads. Only the bytes say which.
//
// So: for every item holding a miss, fetch every file-shaped address on it, from both sides, and
// print the digest. Two addresses answering with one digest are an alias and no defect. Two digests
// are an attachment a sync has never brought across.
//
// It downloads and keeps nothing — no destination is touched, and nothing reaches the disk.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE_URL = "https://ntulearn.ntu.edu.sg";
const FILE_SHAPED = /\/bbcswebdav\/|xid-/i;
const USAGE = "Usage: node prototype/settle.mjs <course|all>";

async function walked(profilePath, courses) {
  const client = await openClient(profilePath);
  const byKey = new Map();

  try {
    for (const course of courses) {
      await writeLine(stderr, `walk: ${course.key}`);
      const snapshot = await client.readCourse(course.courseId);
      const byItem = new Map();
      for await (const { item, attachment, placement } of expectedAttachments({
        client,
        courseId: course.courseId,
        items: snapshot.items,
      })) {
        const found = byItem.get(item.id) ?? new Map();
        found.set(comparable(attachment.resourceUrl), {
          url: attachment.resourceUrl,
          file: placement.file,
          trail: placement.trail,
        });
        byItem.set(item.id, found);
      }
      byKey.set(course.key, byItem);
    }
  } finally {
    await client.close();
  }

  return byKey;
}

// One item at a time and one address at a time, because a course is a handful of items here and
// the point is a readable answer rather than a fast one.
async function settle(secondReader, walkByItem, reader) {
  const onItem = new Map();
  for (const link of reader.links) {
    if (!FILE_SHAPED.test(link.link)) continue;
    onItem.set(link.itemId, [...(onItem.get(link.itemId) ?? []), link]);
  }

  const settled = [];
  for (const [itemId, links] of onItem) {
    const expected = walkByItem.get(itemId) ?? new Map();
    if (links.every((link) => expected.has(comparable(link.link)))) continue;

    const addresses = new Map();
    for (const [url, attachment] of expected) addresses.set(url, { ...attachment, side: "walk" });
    for (const link of links) {
      const url = comparable(link.link);
      const already = addresses.get(url);
      addresses.set(url, {
        url: already?.url ?? link.link,
        file: already?.file ?? null,
        trail: already?.trail ?? null,
        side: already ? "both" : "reader",
        field: link.field,
        context: link.context,
      });
    }

    const weighed = [];
    for (const address of addresses.values()) {
      await writeLine(stderr, `weigh: ${address.url}`);
      weighed.push({ ...address, ...(await secondReader.weigh(address.url)) });
    }
    settled.push({ itemId, title: links[0].itemTitle, addresses: weighed });
  }

  return settled;
}

// The verdict, said once rather than left to whoever reads the digests. An address only the reader
// has, whose bytes nothing the walk downloaded matches, is an attachment no sync has ever written.
function verdict(addresses) {
  const downloaded = new Set(
    addresses.filter((each) => each.side !== "reader" && each.sha256).map((each) => each.sha256),
  );
  const unwritten = addresses.filter(
    (each) => each.side === "reader" && each.sha256 && !downloaded.has(each.sha256),
  );
  const aliases = addresses.filter(
    (each) => each.side === "reader" && each.sha256 && downloaded.has(each.sha256),
  );
  const unreachable = addresses.filter((each) => each.side === "reader" && !each.sha256);

  return {
    unwritten: unwritten.length,
    aliases: aliases.length,
    unreachable: unreachable.length,
  };
}

function comparable(url) {
  try {
    const { origin, pathname } = new URL(url, BASE_URL);
    return `${origin}${pathname}`;
  } catch {
    return url;
  }
}

async function main([key]) {
  if (!key) {
    await writeLine(stderr, USAGE);
    return 1;
  }

  const config = await loadConfig(ROOT);
  const courses = selectCourses(config.courses, key);
  const walk = await walked(config.profilePath, courses);

  const secondReader = await openSecondReader(config.profilePath);
  const report = [];
  try {
    for (const course of courses) {
      await writeLine(stderr, `grep: ${course.key}`);
      const reader = await secondReader.read(course.courseId);
      const items = await settle(secondReader, walk.get(course.key), reader);
      if (!items.length) continue;
      report.push({
        key: course.key,
        items,
        totals: items
          .map((item) => verdict(item.addresses))
          .reduce((running, each) => ({
            unwritten: running.unwritten + each.unwritten,
            aliases: running.aliases + each.aliases,
            unreachable: running.unreachable + each.unreachable,
          })),
      });
    }
  } finally {
    await secondReader.close();
  }

  await writeLine(stdout, JSON.stringify({ courses: report }, null, 2));
  return 0;
}

const status = await main(process.argv.slice(2)).catch(async (error) => {
  await writeLine(stderr, error.message);
  return 1;
});

process.exit(status);
