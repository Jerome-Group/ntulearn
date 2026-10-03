import { constants } from "node:fs";
import { lstat, realpath, mkdir, open } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { resolve, join, dirname, basename } from "node:path";
import { setTimeout, clearTimeout } from "node:timers";
import { performance } from "node:perf_hooks";
import { createCheckCapture } from "./check-capture.mjs";

const IO_MS = 5000,
  SETTLE_MS = 5000,
  TOTAL_IO_MS = 30000;
const CHECKS = ["syntax", "contracts", "format", "lint", "test"];
const failure = (code) =>
  Object.assign(new Error("Private check evidence could not be confirmed."), { code });
const identity = (stat) => `${stat.dev}:${stat.ino}:${stat.uid}:${stat.mode}`;
const fileIdentity = (stat) =>
  `${identity(stat)}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.nlink}`;

export async function createCheckEvidence({
  root,
  directory,
  ownerUid,
  inspect = lstat,
  canonical = realpath,
  makeDirectory = mkdir,
  openFile = open,
  ioMs = IO_MS,
  settleMs = SETTLE_MS,
  totalIoMs = TOTAL_IO_MS,
}) {
  if (typeof directory !== "string" || Buffer.byteLength(directory) > 4096)
    throw failure("CHECK_EVIDENCE_PATH");
  if (
    [
      [ioMs, IO_MS],
      [settleMs, SETTLE_MS],
      [totalIoMs, TOTAL_IO_MS],
    ].some(([value, maximum]) => !Number.isSafeInteger(value) || value < 1 || value > maximum)
  )
    throw failure("CHECK_EVIDENCE_BOUND");
  root = resolve(root);
  const path = resolve(root, directory),
    scratch = join(root, ".scratch");
  if (dirname(path) !== scratch || !/^check-evidence-[A-Za-z0-9_-]{1,80}$/.test(basename(path)))
    throw failure("CHECK_EVIDENCE_PATH");
  let spentMs = 0,
    stopped = false;
  const files = [],
    pins = new Map();

  async function bounded(operation) {
    if (stopped) throw failure("CHECK_EVIDENCE_IO");
    let expired = false,
      timer,
      settlementTimer;
    const started = performance.now(),
      limit = Math.min(ioMs, totalIoMs - spentMs);
    if (limit <= 0) {
      stopped = true;
      throw failure("CHECK_EVIDENCE_IO");
    }
    const active = () => {
      if (expired) throw failure("CHECK_EVIDENCE_IO");
    };
    const pending = Promise.resolve().then(() => operation(active));
    try {
      return await Promise.race([
        pending,
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => {
            expired = true;
            reject(failure("CHECK_EVIDENCE_IO"));
          }, limit);
        }),
      ]);
    } catch (error) {
      stopped = true;
      if (expired) {
        const settledFailure = await Promise.race([
          pending.then(
            () => null,
            (cause) => cause,
          ),
          new Promise((_resolve, reject) => {
            settlementTimer = setTimeout(() => reject(failure("CHECK_EVIDENCE_CLEANUP")), settleMs);
          }),
        ]);
        if (settledFailure?.code === "CHECK_EVIDENCE_CLEANUP") throw settledFailure;
      }
      throw error?.code?.startsWith("CHECK_EVIDENCE_") ? error : failure("CHECK_EVIDENCE_IO");
    } finally {
      clearTimeout(timer);
      clearTimeout(settlementTimer);
      spentMs += Math.max(0, performance.now() - started);
    }
  }

  async function closeOwned(handle) {
    try {
      await handle.close();
    } catch {
      throw failure("CHECK_EVIDENCE_CLEANUP");
    }
  }

  async function parentPins(active) {
    for (const [parent, pin] of pins) {
      const stat = await inspect(parent);
      active();
      if (!stat.isDirectory() || stat.isSymbolicLink() || identity(stat) !== pin)
        throw failure("CHECK_EVIDENCE_PATH");
      const physical = await canonical(parent);
      active();
      if (physical !== parent) throw failure("CHECK_EVIDENCE_PATH");
    }
  }

  async function write(name, value) {
    if (
      !/^(?:run\.(?:start|result)|(?:syntax|contracts|format|lint|test)-\d+\.(?:stdout|stderr|invocation))\.(?:json|log)$/.test(
        name,
      )
    )
      throw failure("CHECK_EVIDENCE_IO");
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const maximum = name.endsWith(".log")
      ? 2 * 1024 * 1024
      : name.endsWith(".invocation.json")
        ? 64 * 1024
        : 128 * 1024;
    if (
      bytes.length > maximum ||
      files.length >= 17 ||
      files.reduce((sum, file) => sum + file.bytes, 0) + bytes.length > 21 * 1024 * 1024
    ) {
      stopped = true;
      throw failure("CHECK_EVIDENCE_BOUND");
    }
    const expectedSha256 = createHash("sha256").update(bytes).digest("hex");
    await bounded(async (active) => {
      let handle, before, verified;
      try {
        await parentPins(active);
        active();
        handle = await openFile(
          join(path, name),
          constants.O_RDWR |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW |
            constants.O_NONBLOCK,
          0o600,
        );
        active();
        await parentPins(active);
        active();
        before = await handle.stat();
        active();
        if (
          !before.isFile() ||
          before.nlink !== 1 ||
          before.uid !== ownerUid ||
          (before.mode & 0o777) !== 0o600
        )
          throw failure("CHECK_EVIDENCE_PATH");
        const openedLeaf = await inspect(join(path, name));
        active();
        if (
          openedLeaf.isSymbolicLink() ||
          !openedLeaf.isFile() ||
          identity(openedLeaf) !== identity(before)
        )
          throw failure("CHECK_EVIDENCE_PATH");
        await handle.writeFile(bytes);
        active();
        await handle.sync();
        active();
        const written = await handle.stat();
        active();
        const actual = createHash("sha256"),
          buffer = Buffer.alloc(65536);
        let position = 0;
        while (position <= bytes.length) {
          const { bytesRead } = await handle.read(
            buffer,
            0,
            Math.min(buffer.length, bytes.length + 1 - position),
            position,
          );
          active();
          if (!bytesRead) break;
          actual.update(buffer.subarray(0, bytesRead));
          position += bytesRead;
        }
        if (position !== bytes.length || actual.digest("hex") !== expectedSha256)
          throw failure("CHECK_EVIDENCE_IO");
        await parentPins(active);
        active();
        const leaf = await inspect(join(path, name));
        active();
        const after = await handle.stat();
        active();
        if (
          leaf.isSymbolicLink() ||
          !leaf.isFile() ||
          leaf.dev !== before.dev ||
          leaf.ino !== before.ino ||
          identity(leaf) !== identity(after) ||
          identity(after) !== identity(before) ||
          after.nlink !== 1 ||
          after.size !== bytes.length ||
          fileIdentity(written) !== fileIdentity(after) ||
          fileIdentity(leaf) !== fileIdentity(after)
        )
          throw failure("CHECK_EVIDENCE_PATH");
        verified = after;
      } finally {
        if (handle) await closeOwned(handle);
      }
      await parentPins(active);
      active();
      const closedLeaf = await inspect(join(path, name));
      active();
      if (
        !closedLeaf.isFile() ||
        closedLeaf.isSymbolicLink() ||
        identity(closedLeaf) !== identity(before) ||
        closedLeaf.size !== bytes.length ||
        closedLeaf.nlink !== 1 ||
        fileIdentity(closedLeaf) !== fileIdentity(verified)
      )
        throw failure("CHECK_EVIDENCE_PATH");
    });
    const receipt = {
      file: name,
      bytes: bytes.length,
      sha256: expectedSha256,
    };
    files.push(receipt);
    return receipt;
  }

  await bounded(async (active) => {
    const stat = await inspect(root);
    active();
    ownerUid ??= stat.uid;
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== ownerUid ||
      (await canonical(root)) !== root
    )
      throw failure("CHECK_EVIDENCE_PATH");
    active();
    pins.set(root, identity(stat));
    await parentPins(active);
    try {
      await makeDirectory(scratch, { mode: 0o700 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    active();
    const parent = await inspect(scratch);
    active();
    if (
      !parent.isDirectory() ||
      parent.isSymbolicLink() ||
      parent.uid !== ownerUid ||
      (await canonical(scratch)) !== scratch
    )
      throw failure("CHECK_EVIDENCE_PATH");
    active();
    pins.set(scratch, identity(parent));
    await parentPins(active);
    active();
    try {
      await makeDirectory(path, { mode: 0o700 });
    } catch (error) {
      if (error.code === "EEXIST") throw failure("CHECK_EVIDENCE_OCCUPIED");
      throw error;
    }
    active();
    const owned = await inspect(path);
    active();
    if (
      !owned.isDirectory() ||
      owned.isSymbolicLink() ||
      owned.uid !== ownerUid ||
      (owned.mode & 0o777) !== 0o700 ||
      (await canonical(path)) !== path
    )
      throw failure("CHECK_EVIDENCE_PATH");
    active();
    pins.set(path, identity(owned));
    await parentPins(active);
  });
  await write("run.start.json", `${JSON.stringify({ version: 1, status: "running" })}\n`);

  return {
    snapshot: () => ({
      reference: "requested-private-evidence",
      files: [...files],
      complete: false,
    }),
    async record({ id, ordinal, command, argumentsFor, result }) {
      if (!CHECKS.includes(id) || !Number.isSafeInteger(ordinal) || ordinal < 1)
        throw failure("CHECK_EVIDENCE_BOUND");
      const prefix = `${id}-${String(ordinal).padStart(3, "0")}`;
      let captured = result.rawOutput;
      if (!captured) {
        const capture = createCheckCapture();
        capture.append("stdout", result.stdout ?? "");
        capture.append("stderr", result.stderr ?? "");
        captured = capture.result();
      }
      const streams = {};
      for (const name of ["stdout", "stderr"]) {
        const value = captured[name];
        if (
          !Buffer.isBuffer(value?.prefix) ||
          !Number.isSafeInteger(value.bytes) ||
          value.bytes < value.prefix.length ||
          typeof value.sha256 !== "string" ||
          !/^[a-f0-9]{64}$/.test(value.sha256) ||
          value.truncated !== value.bytes > value.prefix.length
        )
          throw failure("CHECK_EVIDENCE_BOUND");
        const receipt = await write(`${prefix}.${name}.log`, value.prefix);
        streams[name] = {
          ...receipt,
          capturedBytes: value.bytes,
          capturedSha256: value.sha256,
          truncated: value.truncated,
        };
      }
      const invocation = JSON.stringify({
        version: 1,
        check: id,
        ordinal,
        command,
        arguments: argumentsFor,
        cwd: root,
        exitCode: result.exitCode ?? 1,
        timedOut: result.timedOut === true,
        streams,
      });
      if (Buffer.byteLength(invocation) > 64 * 1024) throw failure("CHECK_EVIDENCE_BOUND");
      const receipt = await write(`${prefix}.invocation.json`, `${invocation}\n`);
      return { reference: `requested-private-evidence/${prefix}`, invocation: receipt, streams };
    },
    async finish(result) {
      const receipt = JSON.stringify({
        version: 1,
        evidenceStatus: "pending-final-settlement",
        checkResult: result,
      });
      if (Buffer.byteLength(receipt) > 128 * 1024) throw failure("CHECK_EVIDENCE_BOUND");
      await write("run.result.json", `${receipt}\n`);
      return { reference: "requested-private-evidence", files: [...files], complete: true };
    },
  };
}
