import test from "node:test";
import { Buffer } from "node:buffer";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  writeFile,
  readFile,
  readdir,
  rm,
  symlink,
  lstat,
  rename,
  utimes,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordSourceEdition, provenanceRecords } from "../src/sync/source-provenance.mjs";
const hash = (v) => createHash("sha256").update(v).digest("hex");
const identity = hash("synthetic-owned");
const expected = {
  source: { identity, kind: "announcement", version: hash("UPSTREAM"), originalPath: "Notice.md" },
  content: "UPSTREAM",
};
async function fixture(fn) {
  const destination = await mkdtemp(join(tmpdir(), "source-provenance-"));
  try {
    await fn(destination);
  } finally {
    await rm(destination, { recursive: true, force: true });
  }
}
test("provenance records only accepted current bytes and immutable retries reuse", () =>
  fixture(async (destination) => {
    const path = join(destination, "Notice.md");
    await writeFile(path, "UPSTREAM");
    await recordSourceEdition(destination, expected, path);
    const directory = join(destination, "Source editions", identity);
    const before = await readdir(directory);
    await recordSourceEdition(destination, expected, path);
    assert.deepEqual(await readdir(directory), before);
    const records = await provenanceRecords(destination, expected.source);
    assert.equal(records[0].sha256, hash("UPSTREAM"));
    assert.equal(records[0].bytes, 8);
    await writeFile(path, "USEREDIT");
    await assert.rejects(recordSourceEdition(destination, expected, path), /Source changed.*Retry/);
    assert.equal(await readFile(path, "utf8"), "USEREDIT");
    assert.deepEqual(await readdir(directory), before);
  }));
test("attachment revision provenance binds fingerprint to accepted bytes", () =>
  fixture(async (destination) => {
    const path = join(destination, "Guide.pdf");
    await writeFile(path, "PDF TWO");
    const source = {
      identity,
      kind: "attachment",
      version: hash("PDF TWO"),
      fingerprint: hash("current metadata"),
      originalPath: "Guide.pdf",
    };
    await recordSourceEdition(destination, { source }, path, {
      bytes: 7,
      sha256: hash("PDF TWO"),
    });
    const directory = join(destination, "Source editions", identity);
    const [name] = await readdir(directory);
    const record = JSON.parse(await readFile(join(directory, name), "utf8"));
    assert.equal(record.schemaVersion, 2);
    assert.equal(record.version, hash("PDF TWO"));
    assert.equal(record.fingerprint, hash("current metadata"));
    assert.equal((await provenanceRecords(destination, source)).length, 1);
    await rm(join(directory, name));
    record.fingerprint = "bad";
    const body = JSON.stringify(record) + "\n";
    await writeFile(join(directory, hash(body) + ".json"), body);
    await assert.rejects(provenanceRecords(destination, source), /provenance.*Restore/);
  }));
test("edited provenance and symlinked provenance parents refuse without touching originals", () =>
  fixture(async (destination) => {
    const path = join(destination, "Notice.md");
    await writeFile(path, "UPSTREAM");
    await recordSourceEdition(destination, expected, path);
    const directory = join(destination, "Source editions", identity);
    const [name] = await readdir(directory);
    await writeFile(join(directory, name), "{}");
    await assert.rejects(provenanceRecords(destination, expected.source), /provenance.*Restore/);
    assert.equal(await readFile(path, "utf8"), "UPSTREAM");
    await rm(directory, { recursive: true });
    await symlink(destination, directory);
    await assert.rejects(provenanceRecords(destination, expected.source), /symlink.*run/);
  }));
test("malformed, oversized and excessive provenance remain bounded failures", () =>
  fixture(async (destination) => {
    const directory = join(destination, "Source editions", identity);
    await mkdir(directory, { recursive: true });
    const path = join(directory, hash("file") + ".json");
    await writeFile(path, "x".repeat(65537));
    await assert.rejects(provenanceRecords(destination, expected.source), /malformed.*Restore/);
    await rm(path);
    await Promise.all(
      Array.from({ length: 129 }, (_, i) =>
        writeFile(join(directory, hash(String(i)) + ".json"), "{}"),
      ),
    );
    await assert.rejects(provenanceRecords(destination, expected.source), /too large.*Inspect/);
  }));

test("qualified native metadata survives repeated provenance reads and publication without providing records", () =>
  fixture(async (destination) => {
    const path = join(destination, "Notice.md");
    await writeFile(path, "UPSTREAM");
    await recordSourceEdition(destination, expected, path);
    const directory = join(destination, "Source editions", identity);
    const native = new Map([
      ["Icon\r", Buffer.alloc(0)],
      [".DS_Store", Buffer.from("000000014275643100010203", "hex")],
    ]);
    for (const [name, bytes] of native) await writeFile(join(directory, name), bytes);
    const names = await readdir(directory);
    const before = await Promise.all(names.map((name) => readFile(join(directory, name))));
    for (let repeat = 0; repeat < 2; repeat++) {
      const records = await provenanceRecords(destination, expected.source);
      assert.equal(records.length, 1);
      assert.equal(records[0].sha256, hash("UPSTREAM"));
      await recordSourceEdition(destination, expected, path);
      assert.deepEqual(await readdir(directory), names);
      for (const [index, name] of names.entries())
        assert.deepEqual(await readFile(join(directory, name)), before[index]);
      assert.equal(await readFile(path, "utf8"), "UPSTREAM");
    }
    const empty = join(destination, "Source editions", hash("metadata-only"));
    await mkdir(empty);
    for (const [name, bytes] of native) await writeFile(join(empty, name), bytes);
    assert.deepEqual(
      await provenanceRecords(destination, { ...expected.source, identity: hash("metadata-only") }),
      [],
    );
  }));

test("native metadata does not consume the 128-record provenance allowance", () =>
  fixture(async (destination) => {
    const directory = join(destination, "Source editions", identity);
    await mkdir(directory, { recursive: true });
    for (let i = 0; i < 128; i++) {
      const body =
        JSON.stringify({
          schemaVersion: 1,
          sourceIdentity: identity,
          kind: "announcement",
          version: hash("UPSTREAM"),
          originalPath: null,
          relativePath: `Edition-${i}.md`,
          bytes: 8,
          sha256: hash("UPSTREAM"),
        }) + "\n";
      await writeFile(join(directory, hash(body) + ".json"), body);
    }
    await writeFile(join(directory, "Icon\r"), "");
    await writeFile(join(directory, ".DS_Store"), Buffer.from("0000000142756431", "hex"));
    const before = await readdir(directory);
    assert.equal((await provenanceRecords(destination, expected.source)).length, 128);
    assert.deepEqual(await readdir(directory), before);
    await writeFile(join(directory, hash("excess") + ".json"), "{}");
    await assert.rejects(provenanceRecords(destination, expected.source), /too large.*Inspect/);
    assert.equal((await readdir(directory)).length, 131);
  }));

test("unknown, nonempty, malformed and oversized native candidates refuse and retain every byte", () =>
  fixture(async (destination) => {
    const path = join(destination, "Notice.md");
    await writeFile(path, "UPSTREAM");
    await recordSourceEdition(destination, expected, path);
    const directory = join(destination, "Source editions", identity);
    const [recordName] = await readdir(directory);
    const recordBytes = await readFile(join(directory, recordName));
    const candidates = [
      ["Icon", Buffer.alloc(0)],
      ["icon\r", Buffer.alloc(0)],
      ["Icon\r", Buffer.from("user content")],
      [".DS_Store", Buffer.alloc(0)],
      [".DS_Store", Buffer.from("0000000042756431", "hex")],
      [
        ".DS_Store",
        Buffer.concat([Buffer.from("0000000142756431", "hex"), Buffer.alloc(1024 * 1024)]),
      ],
    ];
    for (const [name, body] of candidates) {
      const candidate = join(directory, name);
      await writeFile(candidate, body);
      await assert.rejects(
        provenanceRecords(destination, expected.source),
        /provenance.*Restore|metadata.*Inspect/,
      );
      assert.deepEqual(await readFile(candidate), body);
      assert.deepEqual(await readFile(join(directory, recordName)), recordBytes);
      assert.equal(await readFile(path, "utf8"), "UPSTREAM");
      await rm(candidate);
    }
    const candidate = join(directory, "Icon\r");
    await mkdir(candidate);
    await assert.rejects(provenanceRecords(destination, expected.source), /metadata.*Inspect/);
    assert.ok((await lstat(candidate)).isDirectory());
  }));

test("symlinked native candidates refuse without reading or changing their target", () =>
  fixture(async (destination) => {
    const directory = join(destination, "Source editions", identity);
    await mkdir(directory, { recursive: true });
    const target = join(destination, "retained.txt");
    await writeFile(target, "USER ORIGINAL");
    for (const name of ["Icon\r", ".DS_Store"]) {
      const path = join(directory, name);
      await symlink(target, path);
      await assert.rejects(provenanceRecords(destination, expected.source), /symlink.*run/);
      assert.ok((await lstat(path)).isSymbolicLink());
      assert.equal(await readFile(target, "utf8"), "USER ORIGINAL");
      await rm(path);
    }
  }));

test("native qualification refuses replacement and same-size changes during the descriptor read", () =>
  fixture(async (destination) => {
    const directory = join(destination, "Source editions", identity);
    await mkdir(directory, { recursive: true });
    for (const [name, bytes, replacement] of [
      ["Icon\r", Buffer.alloc(0), true],
      [".DS_Store", Buffer.from("000000014275643100010203", "hex"), false],
    ]) {
      const path = join(directory, name);
      await writeFile(path, bytes);
      let visits = 0;
      const inspect = async (file) => {
        if (file === path && ++visits === 2) {
          if (replacement) {
            await rename(path, join(directory, "retained-original"));
            await writeFile(path, bytes);
          } else {
            await writeFile(path, Buffer.from("000000014275643100010204", "hex"));
            await utimes(path, 1, 1);
          }
        }
        return lstat(file);
      };
      await assert.rejects(
        provenanceRecords(destination, expected.source, { inspect }),
        /metadata.*changed.*Inspect/,
      );
      assert.equal(visits, 2);
      if (replacement) {
        assert.deepEqual(await readFile(join(directory, "retained-original")), bytes);
        assert.deepEqual(await readFile(path), bytes);
        await rm(join(directory, "retained-original"));
      } else assert.deepEqual(await readFile(path), Buffer.from("000000014275643100010204", "hex"));
      await rm(path);
    }
  }));

test("repeat sync and presence verification retain qualified metadata, provenance and source bytes", () =>
  fixture(async (destination) => {
    const { syncCourse } = await import("../src/sync/course.mjs");
    const { verifyCourse } = await import("../src/sync/verify.mjs");
    const course = { key: "SYNTHETIC", courseId: "synthetic", destination };
    const client = {
      readCourse: async () => ({
        course: { displayName: "Synthetic" },
        items: [],
        announcements: [
          {
            id: "notice",
            title: "Notice",
            createdDate: "2026-01-01T01:00:00Z",
            body: { rawText: "UPSTREAM" },
          },
        ],
        conversations: [],
      }),
      readAttachments: async () => [],
    };
    const state = { courses: {} };
    assert.equal((await syncCourse({ client, course, state })).failures.length, 0);
    const provenance = join(destination, "Source editions");
    const [id] = await readdir(provenance);
    const directory = join(provenance, id);
    await writeFile(join(directory, "Icon\r"), "");
    await writeFile(join(directory, ".DS_Store"), Buffer.from("000000014275643100010203", "hex"));
    const retained = new Map();
    async function remember(at) {
      for (const entry of await readdir(at, { withFileTypes: true })) {
        const path = join(at, entry.name);
        if (entry.isDirectory()) await remember(path);
        else if (!["Last synced.md", "Sync status.json"].includes(entry.name))
          retained.set(path, await readFile(path));
      }
    }
    await remember(destination);
    for (const runState of [state, { courses: {} }]) {
      const result = await syncCourse({ client, course, state: runState });
      assert.equal(result.failures.length, 0);
      assert.equal(result.newEditions, 0);
      assert.equal((await verifyCourse({ client, course })).missing.length, 0);
      for (const [path, bytes] of retained) assert.deepEqual(await readFile(path), bytes);
    }
  }));
