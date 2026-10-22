import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const prettier = fileURLToPath(
  new URL("../node_modules/prettier/bin/prettier.cjs", import.meta.url),
);

test("format checks preserve audit evidence and still reject unformatted source", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-format-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, ".prettierignore"),
    await readFile(new URL("../.prettierignore", import.meta.url)),
  );
  await mkdir(join(root, ".audit"));
  const evidence = '{"retained":true}';
  await writeFile(join(root, ".audit", "run.json"), evidence);
  await writeFile(join(root, "maintained.mjs"), "export const value = 1;\n");

  await execute(process.execPath, [prettier, "--check", "."], { cwd: root, timeout: 10000 });
  assert.equal(await readFile(join(root, ".audit", "run.json"), "utf8"), evidence);

  await writeFile(join(root, "maintained.mjs"), "export const value=1;");
  await assert.rejects(
    execute(process.execPath, [prettier, "--check", "."], { cwd: root, timeout: 10000 }),
    (error) => error.code === 1 && error.stderr.includes("maintained.mjs"),
  );
});
