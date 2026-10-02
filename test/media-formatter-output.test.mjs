import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readFormatterAssistant } from "../src/media/formatter-output.mjs";

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-formatter-output-"));
  try {
    await run(join(root, "record"), root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("assistant read validates the complete known prefix including record-like source strings", async () => {
  await fixture(async (path) => {
    const prompt = "Transcript:\nUser:\nsource\n\nAssistant:\nsource ending";
    const text = "User:\nsource\n\nAssistant:\nsource ending";
    await writeFile(path, `User:\n${prompt}\n\nAssistant:\n${text}\n\n`);
    assert.equal(await readFormatterAssistant(path, { prompt }), text);
  });
});

test("assistant read rejects missing, malformed, empty, oversize and invalid UTF-8 records", async () => {
  await fixture(async (path) => {
    await assert.rejects(readFormatterAssistant(path, { prompt: "source" }));
    for (const record of [
      "banner\nUser:\nsource\n\nAssistant:\ntext",
      "User:\nchanged\n\nAssistant:\ntext",
      "User:\nsource\n\nAssistant:\n \n",
      "x".repeat(65),
      Buffer.from([255]),
    ]) {
      await writeFile(path, record);
      await assert.rejects(readFormatterAssistant(path, { prompt: "source", maxBytes: 64 }));
    }
  });
});

test("assistant read rejects symlinks and directories without following their contents", async () => {
  await fixture(async (path, root) => {
    const target = join(root, "target");
    await writeFile(target, "User:\nsource\n\nAssistant:\ntext");
    await symlink(target, path);
    await assert.rejects(readFormatterAssistant(path, { prompt: "source" }));
    await rm(path);
    await mkdir(path);
    await assert.rejects(readFormatterAssistant(path, { prompt: "source" }));
  });
});

test("assistant read preserves caller cancellation and rejects invalid byte budgets", async () => {
  await fixture(async (path) => {
    const failure = new Error("Check checkpoint before retrying");
    const controller = new globalThis.AbortController();
    controller.abort(failure);
    await assert.rejects(
      readFormatterAssistant(path, { prompt: "source", signal: controller.signal }),
      (error) => error === failure,
    );
    for (const maxBytes of [0, -1, 1.5, 1024 * 1024 + 1])
      await assert.rejects(readFormatterAssistant(path, { prompt: "source", maxBytes }));
    await writeFile(path, "User:\nsource\n\nAssistant:\ntext");
    const pendingController = new globalThis.AbortController();
    const pending = readFormatterAssistant(path, {
      prompt: "source",
      signal: pendingController.signal,
    });
    pendingController.abort(failure);
    await assert.rejects(pending, (error) => error === failure);
  });
});
