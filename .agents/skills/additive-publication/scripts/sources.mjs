import assert from "node:assert/strict";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { sha256 } from "./setup.mjs";

export async function snapshot(root, skill, evidence) {
  const coverage = JSON.parse(await readFile(join(skill, "coverage.json"), "utf8"));
  const sources = {};
  const hashes = {};
  for (const [path, contract] of Object.entries(coverage.sources)) {
    const text = await readFile(join(root, path), "utf8");
    assert.deepEqual(
      [...text.matchAll(/^import\b[^]*?;/gm)].map(([line]) => line),
      contract.imports,
      `${path} imports changed. Review the source mapping before updating coverage.json.`,
    );
    for (const [name, expected] of Object.entries(contract.functions)) {
      const body = text.match(
        new RegExp(`^(?:export )?(?:async )?function ${name}\\([^]*?^\\}`, "m"),
      )?.[0];
      assert(body, `${path} ${name} moved. Review publication mapping.`);
      assert.equal(
        sha256(body),
        expected,
        `${path} ${name} changed. Review publication mapping before advancing the sync commit.`,
      );
    }
    sources[path] = text;
    hashes[path] = sha256(text);
    await writeFile(join(evidence, path.replaceAll("/", "-")), text);
  }
  await writeFile(
    join(evidence, "source-hashes.json"),
    JSON.stringify({ coverage, hashes }, null, 2),
  );
  return sources;
}

export async function mirrorSources(sources, skill, mirror, evidence, mutant) {
  for (const [path, source] of Object.entries(sources)) {
    let text = source;
    const mutation =
      mutant === "replace"
        ? ["await link(partial, path)", "await rename(partial, path)"]
        : mutant === "truncate"
          ? [
              "await writeAtomically(partial, body)",
              "await writeAtomically(partial, body.subarray(0, body.length - 1))",
            ]
          : null;
    if (mutation && path === "src/sync/files.mjs") {
      assert.equal(text.split(mutation[0]).length, 2, "Expected exactly one mutation site.");
      const line = text.split("\n").findIndex((line) => line.includes(mutation[0]));
      const before = text.split("\n")[line];
      text = text.replace(...mutation);
      await writeFile(
        join(evidence, "source-mutation.diff"),
        `--- ${path}\n+++ ${mutant}/${path}\n@@ -${line + 1} +${line + 1} @@\n-${before}\n+${before.replace(...mutation)}\n`,
      );
    }
    const originalImport = text.match(/^import .+ from "node:fs\/promises";$/m)?.[0];
    assert(originalImport, `Missing filesystem import in ${path}. Review mapping.`);
    const importLine = text.split("\n").indexOf(originalImport) + 1;
    const replacement = originalImport.replace(
      '"node:fs/promises"',
      JSON.stringify(path === "src/atomic.mjs" ? "../native-fs.mjs" : "../../native-fs.mjs"),
    );
    text = text.replace(originalImport, replacement);
    assert.equal(
      text.replace(replacement, originalImport),
      mutation && path === "src/sync/files.mjs" ? source.replace(...mutation) : source,
    );
    await mkdir(dirname(join(mirror, path)), { recursive: true });
    await writeFile(join(mirror, path), text);
    await writeFile(join(evidence, `${path.replaceAll("/", "-")}.instrumented`), text);
    await writeFile(
      join(evidence, `${path.replaceAll("/", "-")}.imports.diff`),
      `--- ${path}\n+++ mirror/${path}\n@@ -${importLine} +${importLine} @@\n-${originalImport}\n+${replacement}\n`,
    );
  }
  await copyFile(join(skill, "scripts/native-fs.mjs"), join(mirror, "native-fs.mjs"));
}
