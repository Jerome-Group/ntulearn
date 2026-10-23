import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const CLI = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));

function run(cli, configPath, args) {
  return new Promise((done) =>
    execFile(
      process.execPath,
      [cli, "library", ...args],
      {
        env: { ...process.env, NTULEARN_CONFIG_PATH: configPath },
        timeout: 10000,
        maxBuffer: 4 * 1024 * 1024,
      },
      (error, stdout, stderr) => done({ exitCode: error?.code ?? 0, stdout, stderr }),
    ),
  );
}

test("real library CLI lists, searches and exports without dependencies, browser, session or destination writes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn library CLI ü "));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(fileURLToPath(new URL("../src", import.meta.url)), join(root, "src"), {
    recursive: true,
  });
  const destination = join(root, "course");
  await mkdir(destination);
  const page = `# A saved page\r\n${"İ".repeat(300)}Needle appears only in this document body.\r\n`;
  await writeFile(join(destination, "Page.md"), page);
  const configPath = join(root, "config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      profilePath: join(root, "runtime", "profile"),
      statePath: join(root, "runtime", "state.json"),
      courses: [{ key: "AB1234", courseId: "_private_1", destination }],
    }),
  );
  const cli = join(root, "src", "cli.mjs");
  for (const args of [
    [],
    ["--course", "ab1234", "--query", "NEEDLE"],
    ["--query", ""],
    ["--query", "nothing"],
  ]) {
    const result = await run(cli, configPath, args);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, "");
    const value = JSON.parse(result.stdout);
    assert.equal(value.schemaVersion, 1);
    assert.equal(value.matchCount, args.at(-1) === "nothing" ? 0 : 1);
    if (args.includes("NEEDLE")) {
      const match = value.materials[0];
      assert.match(match.snippet, /Needle appears/);
      assert.deepEqual(match.occurrences, { total: 1, returned: 1, omitted: 0 });
      assert.equal(match.passages[0].start, page.indexOf("Needle"));
      assert.equal(match.passages[0].line, 2);
      assert.equal(match.passages[0].column, 301);
    }
    assert(!result.stdout.includes("_private_1"));
  }
  const html = await run(cli, configPath, ["--html", "--query", "needle"]);
  assert.equal(html.exitCode, 0);
  assert.equal(html.stderr, "");
  assert.match(html.stdout, /^<!doctype html>/);
  assert.equal((await run(cli, configPath, ["--query", "😀".repeat(256)])).exitCode, 0);
  assert.equal(await readFile(join(destination, "Page.md"), "utf8"), page);
});

test("real library CLI usage and configuration refusals are structured stdout with actionable exits", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ntulearn library refusals "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "missing.json");
  for (const [args, code] of [
    [[], "CONFIG_UNAVAILABLE"],
    [["--unknown"], "USAGE"],
    [["--course"], "USAGE"],
    [["--html", "--html"], "USAGE"],
    [["--query", "x".repeat(257)], "QUERY_LIMIT"],
    [["--query", "😀".repeat(257)], "QUERY_LIMIT"],
  ]) {
    const result = await run(CLI, configPath, args);
    assert.equal(result.exitCode, 2);
    assert.equal(result.stderr, "");
    const value = JSON.parse(result.stdout);
    assert.equal(value.status, "blocked");
    assert.equal(value.diagnostics[0].code, code);
    assert(value.diagnostics[0].action);
  }
});
