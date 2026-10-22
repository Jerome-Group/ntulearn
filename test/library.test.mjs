import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { localLibrary, LIBRARY_LIMITS } from "../src/library/catalogue.mjs";
import { searchMaterials } from "../src/library/search.mjs";

async function fixture(t, keys = ["AB1234", "CD5678"]) {
  const root = await mkdtemp(join(tmpdir(), "ntulearn library ü "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = {
    profilePath: join(root, "private", "profile"),
    statePath: join(root, "private", "state.json"),
    courses: [],
  };
  for (const key of keys) {
    const destination = join(root, key);
    await mkdir(destination);
    config.courses.push({ key, destination });
  }
  return { root, config, destinations: config.courses.map((course) => course.destination) };
}

async function listing(config, options) {
  const result = await localLibrary(config, options);
  const value = JSON.parse(result.source);
  assert.equal(result.exitCode, value.exitCode);
  return value;
}

test("library searches local Markdown and attachment names with useful literal snippets", async (t) => {
  const {
    config,
    destinations: [first, second],
  } = await fixture(t);
  await mkdir(join(first, "01 Week"));
  const page = `# Notes\n${"Preface ".repeat(40)}Uniform CONVERGENCE [a+b] ends here.\n`;
  await writeFile(join(first, "01 Week", "01 Notes.md"), page);
  await writeFile(join(first, "Exam ü #1.pdf"), "ATTACHMENT_ONLY_SECRET");
  await writeFile(join(second, "Announcement.md"), "# Announcement\nConvergence lecture moved.");
  const all = await listing(config);
  assert.equal(all.schemaVersion, 1);
  assert.equal(all.status, "complete");
  assert.equal(all.exitCode, 0);
  assert.equal(all.materialCount, 3);
  assert.equal(all.matchCount, 3);
  assert.deepEqual(
    all.courses.map((course) => course.receipt.state),
    ["missing", "missing"],
  );
  assert.equal(all.evidence.upstreamCompleteness, "unverified");
  const filtered = await listing(config, { query: "convergence", course: "ab1234" });
  assert.equal(filtered.matchCount, 1);
  assert.match(filtered.materials[0].snippet, /Uniform CONVERGENCE/);
  assert.equal(filtered.materials[0].match, "text");
  assert.equal(filtered.materials[0].text.state, "read");
  assert(
    !Object.hasOwn(filtered.materials[0].text, "value"),
    "JSON carries snippets, not full documents",
  );
  assert.equal((await listing(config, { query: "[A+B]" })).matchCount, 1);
  assert.equal((await listing(config, { query: "Exam Ü #1" })).materials[0].kind, "attachment");
  assert.equal((await listing(config, { query: "ATTACHMENT_ONLY_SECRET" })).matchCount, 0);
  assert.equal((await listing(config, { query: "nothing matches" })).exitCode, 0);
  assert.equal(await readFile(join(first, "01 Week", "01 Notes.md"), "utf8"), page);
});

test("receipt lifecycle, freshness, unread categories and failures stay separate from scan success", async (t) => {
  const {
    config,
    destinations: [destination],
  } = await fixture(t, ["AB1234"]);
  await writeFile(join(destination, "Page.md"), "Local material remains available.");
  const timestamp = new Date(Date.now() - 72 * 3600000).toISOString();
  for (const status of ["running", "complete", "partial", "failed"]) {
    const value = {
      schemaVersion: 1,
      producer: "ntulearn",
      status,
      startedAt: timestamp,
      finishedAt: status === "running" ? null : timestamp,
      lastSuccessfulAt: status === "complete" ? timestamp : null,
      counts: {
        downloaded: 0,
        skipped: 0,
        markdown: 1,
        uncopied: 0,
        failures: status === "partial" || status === "failed" ? 1 : 0,
      },
      unread: status === "partial" ? ["announcements", "conversations"] : [],
    };
    if (status === "running") value.counts.markdown = 0;
    await writeFile(join(destination, "Sync status.json"), JSON.stringify(value));
    const result = await listing(config);
    assert.equal(result.exitCode, 0);
    assert.equal(result.matchCount, 1);
    assert.equal(result.courses[0].receipt.state, status);
    assert.equal(result.courses[0].receipt.stale, true);
    assert.deepEqual(result.courses[0].receipt.value.unread, value.unread);
  }
  for (const source of ["{broken", JSON.stringify({ unexpected: true }), " ".repeat(17000)]) {
    await writeFile(join(destination, "Sync status.json"), source);
    const result = await listing(config);
    assert.equal(result.exitCode, 0);
    assert.equal(result.courses[0].receipt.state, "invalid");
    assert.equal(result.materialCount, 1);
  }
});

test("exclusions do not traverse nested symlinks, provenance, temporary files or special files", async (t) => {
  const {
    root,
    config,
    destinations: [destination],
  } = await fixture(t, ["AB1234"]);
  const outside = join(root, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "secret.md"), "DO_NOT_IMPORT");
  await symlink(outside, join(destination, "Nested alias"));
  await symlink(join(outside, "secret.md"), join(destination, "Leaf.md"));
  await symlink(join(outside, "secret.md"), join(destination, "Sync status.json"));
  for (const directory of [".hidden", "Source editions"]) {
    await mkdir(join(destination, directory));
    await writeFile(join(destination, directory, "secret.md"), "DO_NOT_IMPORT");
  }
  for (const name of ["Last synced.md", "pending.md.part-123", "pending.tmp", ".secret.md"])
    await writeFile(join(destination, name), "DO_NOT_IMPORT");
  await new Promise((done, reject) =>
    execFile("mkfifo", [join(destination, "Pipe.md")], (error) => (error ? reject(error) : done())),
  );
  await writeFile(join(destination, "Visible edition.md"), "A retained visible edition.");
  const result = await listing(config);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(
    result.materials.map((material) => material.name),
    ["Visible edition.md"],
  );
  assert.deepEqual(result.courses[0].exclusions, {
    hidden: 2,
    provenance: 1,
    operational: 2,
    temporary: 2,
    symlink: 2,
    special: 1,
  });
  assert.equal(result.courses[0].receipt.state, "invalid");
  assert.equal((await listing(config, { query: "DO_NOT_IMPORT" })).matchCount, 0);
});

test("root aliases are allowed but lexical and physical runtime overlap refuses before scanning", async (t) => {
  const {
    root,
    config,
    destinations: [destination],
  } = await fixture(t, ["AB1234"]);
  await writeFile(join(destination, "Page.md"), "Safe page.");
  const alias = join(root, "alias");
  await symlink(destination, alias);
  config.courses[0].destination = alias;
  assert.equal((await listing(config)).materialCount, 1);
  for (const runtime of [destination, join(destination, "public-runtime"), root]) {
    const value = await listing({ ...config, profilePath: runtime });
    assert.equal(value.exitCode, 2);
    assert.equal(value.diagnostics[0].code, "RUNTIME_OVERLAP");
    assert.equal(value.materials.length, 0);
  }
  const state = await listing({ ...config, statePath: join(destination, "runtime", "state.json") });
  assert.equal(state.exitCode, 2);
  assert.equal(state.diagnostics[0].code, "RUNTIME_OVERLAP");
});

test("oversized directories are skipped whole and unreadable or bounded Markdown stays findable by name", async (t) => {
  const {
    config,
    destinations: [destination],
  } = await fixture(t, ["AB1234"]);
  await mkdir(join(destination, "Large"));
  await Promise.all(
    Array.from({ length: LIBRARY_LIMITS.entriesPerDirectory + 1 }, (_, index) =>
      writeFile(join(destination, "Large", `${index}.md`), "Directory must be skipped whole."),
    ),
  );
  await writeFile(join(destination, "Oversized.md"), "x".repeat(LIBRARY_LIMITS.markdownBytes + 1));
  await writeFile(join(destination, "Invalid.md"), new Uint8Array([0xff]));
  await writeFile(join(destination, "Safe.md"), "A safe result.");
  const result = await listing(config);
  assert.equal(result.exitCode, 1);
  assert.equal(result.status, "partial");
  assert.equal(result.materialCount, 3);
  assert(result.courses[0].diagnostics.some((entry) => entry.code === "DIRECTORY_SIZE"));
  assert(result.courses[0].diagnostics.some((entry) => entry.code === "TEXT_LIMIT"));
  assert(result.courses[0].diagnostics.some((entry) => entry.code === "TEXT_UNREADABLE"));
  assert.equal((await listing(config, { query: "Oversized" })).matchCount, 1);
});

test("total text, depth and detailed diagnostic limits expose partial scans", async (t) => {
  const {
    config,
    destinations: [destination],
  } = await fixture(t, ["AB1234"]);
  for (let index = 0; index < 34; index += 1)
    await writeFile(
      join(destination, `Text${String(index).padStart(2, "0")}.md`),
      "x".repeat(LIBRARY_LIMITS.markdownBytes),
    );
  for (let index = 0; index < 105; index += 1)
    await writeFile(join(destination, `Bad${index}.md`), new Uint8Array([0xff]));
  let deep = destination;
  for (let index = 0; index <= LIBRARY_LIMITS.depth; index += 1) {
    deep = join(deep, "deep");
    await mkdir(deep);
  }
  await writeFile(join(deep, "Hidden by depth.md"), "Not reached.");
  const result = await listing(config);
  assert.equal(result.exitCode, 1);
  assert.equal(result.courses[0].diagnostics.length, 100);
  assert(result.courses[0].suppressedDiagnostics > 0);
  assert(result.materials.some((entry) => entry.text.reason === "TEXT_LIMIT"));
  assert(!result.materials.some((entry) => entry.name === "Hidden by depth.md"));
});

test("missing destinations retain other courses and empty configurations remain usable", async (t) => {
  const {
    config,
    destinations: [first, second],
  } = await fixture(t);
  await writeFile(join(first, "Page.md"), "Still searchable.");
  await rm(second, { recursive: true });
  const result = await listing(config);
  assert.equal(result.exitCode, 1);
  assert.equal(result.materialCount, 1);
  assert.equal(result.courses[1].scan, "unavailable");
  assert(result.courses[1].diagnostics[0].action);
  assert.equal((await listing({ ...config, courses: [] })).exitCode, 0);
  assert.equal((await listing(config, { course: "unknown" })).exitCode, 2);
});

test("HTML retains the full selected catalogue, literal hostile text, encoded file links and exact trusted CSP hashes", async (t) => {
  const {
    config,
    destinations: [destination],
  } = await fixture(t, ["AB1234"]);
  const hostile =
    '</script><script>globalThis.injected=true</script><img src="https://example.invalid/image">';
  await writeFile(
    join(destination, "Résumé #1 & notes.md"),
    `# Safe heading\n${hostile}\nconvergence`,
  );
  await writeFile(join(destination, "Other.md"), "Unmatched but retained for clearing query.");
  const { source, exitCode } = await localLibrary(config, { format: "html", query: "CONVERGENCE" });
  assert.equal(exitCode, 0);
  assert(!source.includes(hostile));
  const payload = source.match(
    /<script id="catalogue" type="application\/json">([\s\S]*?)<\/script>/,
  )[1];
  const catalogue = JSON.parse(payload);
  assert.equal(catalogue.materials.length, 2);
  assert(catalogue.materials.some((entry) => entry.text.value?.includes(hostile)));
  const matches = searchMaterials(catalogue.materials, catalogue.query);
  assert.equal(matches.length, 1);
  assert.match(matches[0].url, /R%C3%A9sum%C3%A9%20%231%20&%20notes\.md$/);
  const json = await listing(config, { query: "CONVERGENCE" });
  assert.deepEqual(
    matches.map((entry) => [entry.path, entry.snippet, entry.match]),
    json.materials.map((entry) => [entry.path, entry.snippet, entry.match]),
  );
  for (const content of [
    source.match(/<style>([\s\S]*?)<\/style>/)[1],
    source.match(/<script>([\s\S]*?)<\/script>/)[1],
  ])
    assert(source.includes(`sha256-${createHash("sha256").update(content).digest("base64")}`));
  assert.match(source, /default-src &#39;none&#39;/);
  assert.match(source, /id="fallback"/);
  assert.match(source, /textContent/);
  assert.doesNotMatch(source, /\.innerHTML\s*=|fetch\(|localStorage|sessionStorage/);
});
