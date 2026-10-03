import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { lstat, realpath, mkdir, open, rename, unlink } from "node:fs/promises";
import { historicalDigest, publishHistoricalFile } from "./historical-files.mjs";
import { assertRecoveryFileIdentity } from "./recovery-files.mjs";
import { catalogueFailure, catalogueJson, CATALOGUE_POLICY } from "./catalogue-files.mjs";

async function optional(path, reads, options) {
  try {
    return await reads.read(path, options);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return null;
  }
}
const json = (value) => JSON.stringify(value, null, 2) + "\n";
async function directoryProof(path, reads) {
  let ancestor = dirname(path);
  while (true) {
    try {
      const info = await reads.probe(() => lstat(ancestor));
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        (await reads.probe(() => realpath(ancestor))) !== ancestor
      )
        throw catalogueFailure("CATALOGUE_PARENT_CHANGED");
      return { path: ancestor, dev: info.dev, ino: info.ino };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      ancestor = dirname(ancestor);
    }
  }
}
async function assertDirectory(proof, reads) {
  const info = await reads.probe(() => lstat(proof.path));
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.dev !== proof.dev ||
    info.ino !== proof.ino ||
    (await reads.probe(() => realpath(proof.path))) !== proof.path
  )
    throw catalogueFailure("CATALOGUE_PARENT_CHANGED");
}
async function validProducer(path, file, reads) {
  const receiptFile = await reads.read(path + ".catalogue.json"),
    receipt = catalogueJson(receiptFile);
  if (
    receipt.schemaVersion !== 1 ||
    receipt.policy !== CATALOGUE_POLICY ||
    receipt.path !== path ||
    receipt.sha256 !== file.sha256 ||
    !/^[0-9a-f]{24}$/.test(receipt.planId ?? "")
  )
    throw catalogueFailure("CATALOGUE_INDEX_EDITED");
  await assertDirectory(receipt.parent, reads);
  const history = join(dirname(path), ".catalogue-history", receipt.planId);
  const snapshot = await reads.read(join(history, "index.md")),
    journal = catalogueJson(await reads.read(join(history, "journal.json")));
  const complete = catalogueJson(await reads.read(join(history, "complete.json")));
  if (
    snapshot.sha256 !== file.sha256 ||
    journal.policy !== CATALOGUE_POLICY ||
    journal.path !== path ||
    journal.sha256 !== file.sha256 ||
    journal.planId !== receipt.planId ||
    JSON.stringify(complete) !== JSON.stringify(receipt)
  )
    throw catalogueFailure("CATALOGUE_PRODUCER_INVALID");
  if (
    journal.prior.sha256 &&
    (await reads.read(join(history, "before.md"))).sha256 !== journal.prior.sha256
  )
    throw catalogueFailure("CATALOGUE_HISTORY_CHANGED");
  return { sha256: file.sha256, receiptSha256: receiptFile.sha256, planId: receipt.planId };
}
export async function catalogueTarget(course, content, reads) {
  const path = join(course.path, "Transcript editions", "index.md"),
    parent = await directoryProof(path, reads);
  const current = await optional(path, reads);
  let prior;
  if (current) prior = await validProducer(path, current, reads);
  else {
    if (await optional(path + ".catalogue.json", reads))
      throw catalogueFailure("CATALOGUE_PRODUCER_INVALID");
    prior = { absent: true };
  }
  return { path, boundary: course.path, parent, prior, content, sha256: historicalDigest(content) };
}

export async function publishCatalogueTarget({
  target,
  planId,
  reads,
  check,
  checkCapacity,
  checkExisting,
  signal,
  progress,
  afterOutput,
}) {
  await check();
  await assertDirectory(target.parent, reads);
  let parent = await directoryProof(target.path, reads);
  if (parent.path !== dirname(target.path)) {
    await reads.probe(() => mkdir(dirname(target.path), { recursive: true, mode: 0o700 }));
    parent = await directoryProof(target.path, reads);
  }
  if (parent.path !== dirname(target.path)) throw catalogueFailure();
  const history = join(parent.path, ".catalogue-history", planId);
  const receipt = {
    schemaVersion: 1,
    policy: CATALOGUE_POLICY,
    planId,
    path: target.path,
    sha256: target.sha256,
    parent,
  };
  const journal = { ...receipt, prior: target.prior };
  const put = async (path, content) => {
    await assertDirectory(parent, reads);
    const outcome = await publishHistoricalFile(path, Buffer.from(content), {
      reads,
      boundary: target.boundary,
      expectedSha256: historicalDigest(content),
      checkCapacity,
      beforeStage: check,
      existingFile: checkExisting
        ? async (candidate, expected, digest) => {
            await assertDirectory(parent, reads);
            await checkExisting({
              path: candidate,
              boundary: target.boundary,
              bytes: expected.length,
            });
            await assertDirectory(parent, reads);
            const existing = await optional(candidate, reads, { includeIdentity: true });
            if (!existing) return false;
            if (existing.sha256 !== digest || !existing.content.equals(expected))
              throw catalogueFailure();
            await assertRecoveryFileIdentity(existing, signal);
            await assertDirectory(parent, reads);
            await assertRecoveryFileIdentity(existing, signal);
            return true;
          }
        : null,
    });
    progress[outcome]++;
    if (outcome === "written") {
      const directory = await open(dirname(path), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
    await afterOutput?.(path);
  };
  const current = await optional(target.path, reads),
    receiptFile = await optional(target.path + ".catalogue.json", reads);
  const savedJournal = await optional(join(history, "journal.json"), reads);
  const resuming = savedJournal?.content.toString("utf8") === json(journal);
  if (savedJournal && !resuming) throw catalogueFailure("CATALOGUE_HISTORY_CHANGED");
  const alreadyNew = current?.sha256 === target.sha256 && resuming;
  if (!alreadyNew) {
    if (target.prior.absent) {
      if (current || receiptFile) throw catalogueFailure("CATALOGUE_INDEX_OCCUPIED");
    } else if (
      !current ||
      current.sha256 !== target.prior.sha256 ||
      receiptFile?.sha256 !== target.prior.receiptSha256
    )
      throw catalogueFailure("CATALOGUE_INDEX_EDITED");
  }
  // Receipt transition may lag index promotion, but only this journal's old/new producer is accepted.
  if (
    alreadyNew &&
    receiptFile &&
    receiptFile.sha256 !== target.prior.receiptSha256 &&
    receiptFile.content.toString("utf8") !== json(receipt)
  )
    throw catalogueFailure("CATALOGUE_PRODUCER_INVALID");
  await put(join(history, "journal.json"), json(journal));
  if (target.prior.sha256) {
    const before = await optional(join(history, "before.md"), reads);
    if (before) {
      if (before.sha256 !== target.prior.sha256)
        throw catalogueFailure("CATALOGUE_HISTORY_CHANGED");
      progress.existing++;
    } else {
      if (!current || current.sha256 !== target.prior.sha256)
        throw catalogueFailure("CATALOGUE_HISTORY_CHANGED");
      await put(join(history, "before.md"), current.content);
    }
  }
  await put(join(history, "index.md"), target.content);
  const expectedIndex = current?.sha256 ?? null,
    expectedReceipt = receiptFile?.sha256 ?? null;
  if (!alreadyNew) {
    await check();
    await promoteManaged(target.path, target.content, {
      reads,
      parent,
      expectedSha256: expectedIndex,
      checkCapacity,
      boundary: target.boundary,
      onPromotion: () => progress.promoted++,
    });
    await afterOutput?.(target.path);
  }
  const actual = await reads.read(target.path);
  if (actual.sha256 !== target.sha256) throw catalogueFailure("CATALOGUE_INDEX_EDITED");
  if (receiptFile?.content.toString("utf8") !== json(receipt)) {
    await check();
    await promoteManaged(target.path + ".catalogue.json", json(receipt), {
      reads,
      parent,
      expectedSha256: expectedReceipt,
      checkCapacity,
      boundary: target.boundary,
      onPromotion: () => progress.promoted++,
    });
    await afterOutput?.(target.path + ".catalogue.json");
  } else progress.existing++;
  await put(join(history, "complete.json"), json(receipt));
  await verifyCatalogueTarget({ target, planId, reads });
  await check();
}

async function promoteManaged(
  path,
  content,
  { reads, parent, expectedSha256, checkCapacity, boundary, onPromotion },
) {
  await checkCapacity({ path, boundary, bytes: Buffer.byteLength(content) });
  await assertDirectory(parent, reads);
  const partial = path + ".part-" + randomUUID(),
    handle = await open(partial, "wx", 0o600),
    owned = await handle.stat();
  async function own() {
    await assertDirectory(parent, reads);
    const info = await lstat(partial);
    if (!info.isFile() || info.isSymbolicLink() || info.dev !== owned.dev || info.ino !== owned.ino)
      throw catalogueFailure("CATALOGUE_CLEANUP_UNCERTAIN");
  }
  let promoted = false;
  try {
    await handle.writeFile(content);
    await handle.sync();
    await own();
    await checkCapacity({ path, boundary, bytes: Buffer.byteLength(content) });
    const current = await optional(path, reads);
    if ((current?.sha256 ?? null) !== expectedSha256)
      throw catalogueFailure("CATALOGUE_INDEX_EDITED");
    await own();
    reads.active();
    await rename(partial, path);
    promoted = true;
    onPromotion();
    const directory = await open(parent.path, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await handle.close();
    if (!promoted) {
      await own();
      await unlink(partial);
    }
  }
}
export async function verifyCatalogueTarget({ target, planId, reads }) {
  await assertDirectory(target.parent, reads);
  const file = await reads.read(target.path);
  if (file.sha256 !== target.sha256) throw catalogueFailure("CATALOGUE_INDEX_EDITED");
  const producer = await validProducer(target.path, file, reads);
  if (producer.planId !== planId) throw catalogueFailure("CATALOGUE_PRODUCER_INVALID");
}
