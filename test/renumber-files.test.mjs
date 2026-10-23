import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  writeFile,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { renumberFile, renumberRecoveries } from "../src/sync/renumber-files.mjs";

const A = "sync bytes A";
const B = "student edit B";
const proof = {
  kind: "walk-bytes",
  sha256: createHash("sha256").update(A).digest("hex"),
  bytes: A.length,
};

async function fixture(t, hook = "") {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-renumber-claims-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const destination = join(root, "course");
  await mkdir(destination);
  const from = join(destination, "01 Notes.md"),
    to = join(destination, "02 Notes.md");
  await writeFile(from, A);
  const fsPath = join(root, "fs.mjs");
  await writeFile(
    fsPath,
    `
    export * from "node:fs/promises";
    import * as fs from "node:fs/promises";
    import process from "node:process";
    const from = ${JSON.stringify(from)}, to = ${JSON.stringify(to)}, destination = ${JSON.stringify(destination)};
    export const events = [], reads = [];
    let done = false;
    async function signal(point, args) { events.push({point, args}); ${hook} }
    ${["mkdir", "writeFile", "rename", "link", "unlink", "rmdir"]
      .map(
        (method) => `
      export async function ${method}(...args) {
        await signal("before:${method}", args);
        const result = await fs.${method}(...args);
        await signal("after:${method}", args);
        return result;
      }
    `,
      )
      .join("\n")}
    export async function open(...args) {
      await signal("before:open", args);
      const handle = await fs.open(...args);
      if (String(args[0]).endsWith("/payload")) {
        const read = handle.read.bind(handle), close = handle.close.bind(handle);
        handle.read = async (...options) => {
          await signal("before:proof", args);
          const body = await read(...options);
          reads.push({requested: options[2], offset: options[3], bytes: body.bytesRead});
          await signal("after:proof", args);
          return body;
        };
        handle.close = async () => {
          await close();
          await signal("after:proof-close", args);
        };
      }
      return handle;
    }
  `,
  );
  const source = await readFile(new URL("../src/sync/renumber-files.mjs", import.meta.url), "utf8");
  const modulePath = join(root, "renumber-files.mjs");
  await writeFile(
    modulePath,
    source
      .replace('from "node:fs/promises"', 'from "./fs.mjs"')
      .replace(
        'from "./paths.mjs"',
        `from "${new URL("../src/sync/paths.mjs", import.meta.url).href}"`,
      ),
  );
  const operation = await import(pathToFileURL(modulePath));
  const hooks = await import(pathToFileURL(fsPath));
  return { root, destination, from, to, modulePath, hooks, ...operation };
}

const move = (at) =>
  at.renumberFile({ destination: at.destination, from: at.from, to: at.to, proof });
const bytes = (path) =>
  readFile(path, "utf8").catch((error) => (error.code === "ENOENT" ? null : Promise.reject(error)));

async function checkRecovery(at, outcome, captured = A) {
  assert.equal(outcome.kind, "recovery");
  assert.match(outcome.why, /Inspect .*restore only to an empty name/);
  assert.equal(await bytes(join(outcome.claimPath, "payload")), captured);
  assert.deepEqual(
    await at.renumberRecoveries(at.destination),
    await at.renumberRecoveries(at.destination),
  );
  const before = await readdir(at.destination);
  assert.equal((await move(at)).kind, "recovery");
  assert.deepEqual(await readdir(at.destination), before);
}

test("a public source replaced after publication keeps the student's new inode", async (t) => {
  const at = await fixture(
    t,
    `
    if (point === "after:link" && args[1] === to) {
      await fs.writeFile(from + ".editor", ${JSON.stringify(B)});
      await fs.rename(from + ".editor", from);
    }
  `,
  );
  const before = await lstat(at.from);
  assert.equal((await move(at)).kind, "moved");
  assert.equal(await bytes(at.to), A);
  assert.equal(await bytes(at.from), B);
  assert.equal((await lstat(at.to)).ino, before.ino);
  assert.deepEqual((await readdir(at.destination)).sort(), [basename(at.from), basename(at.to)]);
  for (const { point, args } of at.hooks.events) {
    if (point === "before:unlink") assert.ok(args[0] !== at.from && args[0] !== at.to);
    if (point === "before:rename") assert.match(args[1], /\.ntulearn-renumber-[^/]+\/payload$/);
  }
});

test("successful moves retain inode identity and a repeated request cannot recapture it", async (t) => {
  const at = await fixture(t);
  const original = await lstat(at.from);
  assert.equal(
    (await at.renumberFile({ destination: at.destination, from: at.from, to: at.from, proof }))
      .kind,
    "kept",
  );
  assert.equal(await bytes(at.from), A);
  assert.deepEqual(await at.renumberRecoveries(at.destination), []);
  assert.equal((await move(at)).kind, "moved");
  assert.equal(await bytes(at.from), null);
  assert.equal(await bytes(at.to), A);
  assert.equal((await lstat(at.to)).ino, original.ino);
  assert.equal((await move(at)).kind, "kept");
  assert.deepEqual(await at.renumberRecoveries(at.destination), []);
  assert.deepEqual(await readdir(at.destination), [basename(at.to)]);
});

test("replacement before capture refuses unproved bytes and retains even a restored duplicate", async (t) => {
  const at = await fixture(
    t,
    `
    if (point === "before:rename" && args[0] === from) {
      await fs.writeFile(from + ".editor", ${JSON.stringify(B)});
      await fs.rename(from + ".editor", from);
    }
  `,
  );
  const outcome = await move(at);
  await checkRecovery(at, outcome, B);
  assert.equal(outcome.publication, "absent");
  assert.equal(outcome.restoration, "linked-and-retained");
  assert.equal(await bytes(at.from), B);
  assert.equal(await bytes(at.to), null);
  assert.equal((await lstat(outcome.claimPath)).mode & 0o777, 0o700);
  const manifest = JSON.parse(await readFile(join(outcome.claimPath, "manifest.json"), "utf8"));
  assert.deepEqual(manifest.proof, proof);
  assert.equal(manifest.fromName, basename(at.from));
});

test("writes through a pre-existing descriptor after proof and after cleanup follow the renamed inode", async (t) => {
  const at = await fixture(
    t,
    `
    if (point === "before:rename" && args[0] === from) globalThis.held = await fs.open(from, "r+");
    if (point === "before:link" && args[1] === to) await globalThis.held.write("late edits C", 0, "utf8");
    if (point === "after:link" && args[1] === to && await fs.readFile(to, "utf8") !== "late edits C") throw new Error("late descriptor edit lost");
    if (point === "after:rmdir") {
      await globalThis.held.write("later edit D", 0, "utf8");
      await globalThis.held.close();
    }
  `,
  );
  assert.equal((await move(at)).kind, "moved");
  assert.equal(await bytes(at.from), null);
  assert.equal(await bytes(at.to), "later edit D");
  assert.deepEqual(await at.renumberRecoveries(at.destination), []);
});

async function occupy(path, kind, value) {
  if (kind === "file") await writeFile(path, value);
  else if (kind === "directory") await mkdir(path);
  else await symlink(value, path);
}
async function occupant(path, kind) {
  if (kind === "file") return bytes(path);
  if (kind === "directory") return readdir(path);
  return readlink(path);
}

for (const kind of ["file", "directory", "symlink"]) {
  test(`an already occupied ${kind} target refuses without capture`, async (t) => {
    const at = await fixture(t);
    await occupy(at.to, kind, B);
    const before = await occupant(at.to, kind);
    assert.equal((await move(at)).kind, "kept");
    assert.equal(await bytes(at.from), A);
    assert.deepEqual(await occupant(at.to, kind), before);
    assert.deepEqual(await at.renumberRecoveries(at.destination), []);
  });
  for (const oldKind of ["file", "directory", "symlink", "empty"]) {
    test(`a late ${kind} target and ${oldKind} old name retain every occupant and capture`, async (t) => {
      const make = (path, type, value) =>
        type === "empty"
          ? ""
          : type === "file"
            ? `await fs.writeFile(${path}, ${JSON.stringify(value)});`
            : type === "directory"
              ? `await fs.mkdir(${path});`
              : `await fs.symlink(${JSON.stringify(value)}, ${path});`;
      const at = await fixture(
        t,
        `
        if (point === "after:rename" && args[0] === from) {
          ${make("to", kind, "target C")}
          ${make("from", oldKind, B)}
        }
      `,
      );
      const outcome = await move(at);
      await checkRecovery(at, outcome);
      assert.equal(outcome.publication, "absent");
      assert.equal(outcome.restoration, oldKind === "empty" ? "linked-and-retained" : "occupied");
      assert.deepEqual(await occupant(at.to, kind), kind === "directory" ? [] : "target C");
      assert.deepEqual(
        await occupant(at.from, oldKind === "empty" ? "file" : oldKind),
        oldKind === "directory" ? [] : oldKind === "empty" ? A : B,
      );
    });
  }
}

for (const kind of ["symlink", "directory", "fifo"]) {
  test(
    `captured ${kind} is retained without following, reading, or restoring it`,
    { timeout: 5000 },
    async (t) => {
      const at = await fixture(t);
      await rm(at.from);
      const marker = join(at.root, "marker");
      await writeFile(marker, B);
      if (kind === "symlink") await symlink(marker, at.from);
      else if (kind === "directory") {
        await mkdir(at.from);
        await writeFile(join(at.from, "student.txt"), B);
      } else execFileSync("mkfifo", [at.from]);
      const outcome = await move(at);
      assert.equal(outcome.kind, "recovery");
      assert.equal(outcome.restoration, "nonfile-retained");
      assert.equal(await bytes(at.from), null);
      assert.equal(await bytes(at.to), null);
      const payload = join(outcome.claimPath, "payload");
      const info = await lstat(payload);
      assert.ok(
        kind === "symlink"
          ? info.isSymbolicLink()
          : kind === "directory"
            ? info.isDirectory()
            : info.isFIFO(),
      );
      if (kind === "symlink") assert.equal(await readlink(payload), marker);
      if (kind === "directory") assert.equal(await bytes(join(payload, "student.txt")), B);
      assert.equal(await bytes(marker), B);
      assert.equal((await at.renumberRecoveries(at.destination)).length, 1);
    },
  );
}

const failurePoints = [
  "after:mkdir",
  "before:writeFile",
  "after:writeFile",
  "before:rename",
  "after:rename",
  "before:open",
  "before:proof",
  "after:proof",
  "after:proof-close",
  "before:link",
  "after:link",
  "before:unlink",
  "after:unlink",
  "before:rmdir",
  "before:manifest-unlink",
  "after:manifest-unlink",
];
for (const point of failurePoints) {
  test(`failure at ${point} preserves A and leaves a discoverable read-only claim`, async (t) => {
    const at = await fixture(
      t,
      `
      if (!done && (point === ${JSON.stringify(point)} ||
        (${JSON.stringify(point)} === "before:manifest-unlink" && point === "before:unlink" && args[0].endsWith("/manifest.json")) ||
        (${JSON.stringify(point)} === "after:manifest-unlink" && point === "after:unlink" && args[0].endsWith("/manifest.json")))) {
        done = true;
        const failure = new Error("injected failure"); failure.code = "EIO"; throw failure;
      }
    `,
    );
    const outcome = await move(at);
    assert.equal(outcome.kind, "recovery");
    const surviving = [
      await bytes(at.from),
      await bytes(at.to),
      await bytes(join(outcome.claimPath, "payload")),
    ];
    assert.ok(surviving.includes(A), JSON.stringify(surviving));
    if (surviving[2] !== null) assert.equal(surviving[2], A);
    const first = await at.renumberRecoveries(at.destination);
    assert.equal(first.length, 1);
    assert.deepEqual(await at.renumberRecoveries(at.destination), first);
    const before = await readdir(at.destination);
    assert.equal((await move(at)).kind, "recovery");
    assert.deepEqual(await readdir(at.destination), before);
  });
}

const crashPoints = [
  "after:mkdir",
  "after:writeFile",
  "after:rename",
  "after:proof",
  "after:link",
  "after:payload-unlink",
  "after:manifest-unlink",
  "after:rmdir",
  "after:restore",
];
for (const point of crashPoints) {
  test(`process exit at ${point} leaves captured bytes recoverable and never replays intent`, async (t) => {
    const at = await fixture(
      t,
      `
      const selected = point === ${JSON.stringify(point)} ||
        (${JSON.stringify(point)} === "after:payload-unlink" && point === "after:unlink" && args[0].endsWith("/payload")) ||
        (${JSON.stringify(point)} === "after:manifest-unlink" && point === "after:unlink" && args[0].endsWith("/manifest.json")) ||
        (${JSON.stringify(point)} === "after:restore" && point === "after:link" && args[1] === from);
      if (${JSON.stringify(point)} === "after:restore" && point === "before:link" && args[1] === to) {
        const failure = new Error("unsupported link"); failure.code = "ENOTSUP"; throw failure;
      }
      if (selected) process.exit(77);
    `,
    );
    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import {renumberFile} from ${JSON.stringify(pathToFileURL(at.modulePath).href)};
      await renumberFile(${JSON.stringify({ destination: at.destination, from: at.from, to: at.to, proof })});
    `,
      ],
      { encoding: "utf8", timeout: 5000 },
    );
    assert.equal(child.status, 77, child.stderr);
    const claims = (await readdir(at.destination)).filter((name) =>
      name.startsWith(".ntulearn-renumber-"),
    );
    const captured = claims.length ? await bytes(join(at.destination, claims[0], "payload")) : null;
    const surviving = [await bytes(at.from), await bytes(at.to), captured];
    assert.ok(surviving.includes(A), JSON.stringify(surviving));
    if (captured !== null) {
      assert.equal(captured, A);
      const manifest = JSON.parse(
        await readFile(join(at.destination, claims[0], "manifest.json"), "utf8"),
      );
      assert.deepEqual(manifest.proof, proof);
    }
    const first = await renumberRecoveries(at.destination);
    assert.equal(first.length, point === "after:rmdir" ? 0 : 1);
    assert.deepEqual(await renumberRecoveries(at.destination), first);
    if (first.length) {
      await writeFile(at.from + ".editor", B);
      await rename(at.from + ".editor", at.from);
      assert.equal(
        (await renumberFile({ destination: at.destination, from: at.from, to: at.to, proof })).kind,
        "recovery",
      );
      assert.equal(await bytes(at.from), B);
      if (captured !== null) assert.equal(await bytes(join(first[0].claimPath, "payload")), A);
    }
  });
}

test("a partial manifest failure leaves source untouched and malformed intent visible", async (t) => {
  const at = await fixture(
    t,
    `
    if (point === "before:writeFile") {
      await fs.writeFile(args[0], "{broken", args[2]);
      const failure = new Error("partial intent"); failure.code = "ENOSPC"; throw failure;
    }
  `,
  );
  const outcome = await move(at);
  assert.equal(outcome.kind, "recovery");
  assert.equal(await bytes(at.from), A);
  assert.equal(await bytes(join(outcome.claimPath, "payload")), null);
  assert.match((await at.renumberRecoveries(at.destination))[0].why, /intent could not be read/);
});

test("unsupported publication and failed restoration retain their sole captured name", async (t) => {
  const at = await fixture(
    t,
    `
    if (point === "before:link") {
      const failure = new Error("unsupported link"); failure.code = "ENOTSUP"; throw failure;
    }
  `,
  );
  const outcome = await move(at);
  await checkRecovery(at, outcome);
  assert.equal(outcome.publication, "uncertain");
  assert.equal(outcome.restoration, "failed");
  assert.equal(await bytes(at.from), null);
  assert.equal(await bytes(at.to), null);
});

test("recovery discovery does not follow linked claims, payloads, manifests, or descendants", async (t) => {
  const at = await fixture(t);
  const outside = join(at.root, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "student.txt"), B);
  await symlink(outside, join(at.destination, "linked-descendant"));
  await symlink(outside, join(at.destination, ".ntulearn-renumber-linked"));
  const invalid = join(at.destination, ".ntulearn-renumber-invalid");
  await mkdir(invalid);
  await symlink(join(outside, "student.txt"), join(invalid, "manifest.json"));
  const first = await renumberRecoveries(at.destination);
  assert.equal(first.length, 2);
  assert.deepEqual(await renumberRecoveries(at.destination), first);
  assert.equal(await bytes(join(outside, "student.txt")), B);
});

test("oversized, FIFO, and traversal manifests refuse without reading payloads", async (t) => {
  for (const kind of ["oversized", "fifo", "traversal"]) {
    const at = await fixture(t);
    const id = "00000000-0000-0000-0000-000000000000";
    const claim = join(at.destination, ".ntulearn-renumber-" + id);
    await mkdir(claim);
    const manifest = join(claim, "manifest.json");
    if (kind === "oversized") await writeFile(manifest, "x".repeat(4097));
    else if (kind === "fifo") execFileSync("mkfifo", [manifest]);
    else
      await writeFile(
        manifest,
        JSON.stringify({ schemaVersion: 1, id, fromName: "../outside", toName: "next", proof }),
      );
    await writeFile(join(claim, "payload"), B);
    const result = await renumberRecoveries(at.destination);
    assert.equal(result.length, 1);
    assert.match(result[0].why, /bounded regular|malformed/);
    assert.equal(await bytes(join(claim, "payload")), B);
    assert.equal(await bytes(at.from), A);
  }
});

test("discovery depth is bounded and blocks captures on incomplete inspection", async (t) => {
  const at = await fixture(t);
  await mkdir(join(at.destination, ...Array(65).fill("nested")), { recursive: true });
  assert.match((await renumberRecoveries(at.destination))[0].why, /depth limit/);
  assert.equal((await move(at)).kind, "recovery");
  assert.equal(await bytes(at.from), A);
});

test("cross-parent, escaped, and descendant-symlink requests never capture a source", async (t) => {
  const at = await fixture(t);
  const nested = join(at.destination, "nested");
  await mkdir(nested);
  assert.equal(
    (
      await renumberFile({
        destination: at.destination,
        from: at.from,
        to: join(nested, "new"),
        proof,
      })
    ).kind,
    "kept",
  );
  await assert.rejects(
    renumberFile({ destination: nested, from: at.from, to: at.to, proof }),
    /Unsafe destination path/,
  );
  const linked = join(at.destination, "linked");
  await symlink(at.root, linked);
  await assert.rejects(
    renumberFile({
      destination: at.destination,
      from: join(linked, "old"),
      to: join(linked, "new"),
      proof,
    }),
    /symlink/,
  );
  assert.equal(await bytes(at.from), A);
});

test("discovery entry and claim bounds refuse work without modifying the uninspected tree", async (t) => {
  await t.test("claims", async (t) => {
    const at = await fixture(t);
    for (let index = 0; index < 128; index++)
      await mkdir(join(at.destination, `.ntulearn-renumber-incomplete-${index}`));
    const found = await renumberRecoveries(at.destination);
    assert.equal(found.length, 129);
    assert.match(found.at(-1).why, /claim limit/);
    assert.equal((await move(at)).kind, "recovery");
    assert.equal(await bytes(at.from), A);
    assert.equal((await readdir(at.destination)).length, 129);
  });
  await t.test("entries", async (t) => {
    const at = await fixture(t);
    for (let start = 0; start < 10000; start += 100)
      await Promise.all(
        Array.from({ length: 100 }, (_, offset) =>
          writeFile(join(at.destination, `student-${start + offset}`), "retained"),
        ),
      );
    const found = await renumberRecoveries(at.destination);
    assert.equal(found.length, 1);
    assert.match(found[0].why, /entry limit/);
    assert.equal((await move(at)).kind, "recovery");
    assert.equal(await bytes(at.from), A);
    assert.equal((await readdir(at.destination)).length, 10001);
  });
});

test("oversized capture refuses before reading and retains all replacement bytes", async (t) => {
  const replacement = B.repeat(10000);
  const at = await fixture(
    t,
    `
    if (point === "before:rename" && args[0] === from) {
      await fs.writeFile(from + ".editor", ${JSON.stringify(replacement)});
      await fs.rename(from + ".editor", from);
    }
  `,
  );
  const outcome = await move(at);
  await checkRecovery(at, outcome, replacement);
  assert.equal(at.hooks.reads.length, 0);
  assert.equal(await bytes(at.from), replacement);
  assert.equal(await bytes(at.to), null);
});

test("captured growth after the first read consumes at most proof bytes plus one", async (t) => {
  const growth = B.repeat(10000);
  const at = await fixture(
    t,
    `
    if (!done && point === "after:proof") {
      done = true;
      await fs.appendFile(args[0], ${JSON.stringify(growth)});
    }
  `,
  );
  const outcome = await move(at);
  await checkRecovery(at, outcome, A + growth);
  assert.equal(
    at.hooks.reads.reduce((sum, read) => sum + read.bytes, 0),
    proof.bytes + 1,
  );
  assert.equal(at.hooks.reads.length, 2);
  assert.equal(await bytes(at.from), A + growth);
  assert.equal(await bytes(at.to), null);
});

test("proof reads accept empty files and valid files larger than the read buffer", async (t) => {
  for (const content of ["", A.repeat(20000)]) {
    const at = await fixture(t);
    await writeFile(at.from, content);
    const largeProof = {
      kind: "walk-bytes",
      bytes: content.length,
      sha256: createHash("sha256").update(content).digest("hex"),
    };
    assert.equal(
      (
        await at.renumberFile({
          destination: at.destination,
          from: at.from,
          to: at.to,
          proof: largeProof,
        })
      ).kind,
      "moved",
    );
    assert.equal(await bytes(at.to), content);
    assert.equal(await bytes(at.from), null);
    assert.deepEqual(await renumberRecoveries(at.destination), []);
  }
});
