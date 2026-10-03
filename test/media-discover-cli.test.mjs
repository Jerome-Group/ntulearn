import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdtemp, rm, writeFile, readFile, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { mediaQueueLockPath } from "../src/media/lock.mjs";
const require = createRequire(import.meta.url);
for (const signalName of ["SIGINT", "SIGTERM"])
  test(`media discover CLI owns ${signalName}, closes before lock release and emits final failure`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "ntulearn-discover-cli-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await cp(fileURLToPath(new URL("../src", import.meta.url)), join(root, "src"), {
      recursive: true,
    });
    const config = {
      statePath: join(root, "state.json"),
      profilePath: join(root, "profile"),
      courses: [
        { key: "A", courseId: "A", mediaMode: "active", destination: join(root, "courseA") },
        { key: "B", courseId: "B", mediaMode: "active", destination: join(root, "courseB") },
      ],
    };
    const configPath = join(root, "config.json"),
      marker = join(root, "closed.json");
    await writeFile(configPath, JSON.stringify(config));
    await writeFile(
      join(root, "src/config.mjs"),
      `import {readFile} from 'node:fs/promises';export const INITIAL_WATCHDOG_TIMEOUT_MS=1000;export async function loadConfig(){return JSON.parse(await readFile(${JSON.stringify(configPath)},'utf8'))};export function selectCourses(courses,key){if(key!=='all')throw new Error('Default must select all');return courses}`,
    );
    await writeFile(
      join(root, "src/ntulearn/client.mjs"),
      `import {writeFile} from 'node:fs/promises';export async function openClient(_path,options){if(options.signalOwner!=='caller')throw new Error('Missing caller ownership');let rejectRead,timer;return {readCourse:async()=>{process.stdout.write('READY\\n');await new Promise((resolve,reject)=>{rejectRead=reject;timer=setTimeout(()=>reject(new Error('Fixture expired')),2000)})},close:async()=>{await new Promise(resolve=>setTimeout(resolve,10));clearTimeout(timer);rejectRead?.(new Error('Owned context closed'));await writeFile(${JSON.stringify(marker)},JSON.stringify({closed:true}))}}}`,
    );
    const bootstrap = join(root, "bootstrap.mjs");
    await writeFile(
      bootstrap,
      `import playwright from ${JSON.stringify(pathToFileURL(require.resolve("playwright")).href)};const {chromium}=playwright;chromium.launchPersistentContext=()=>{throw new Error('Forbidden actual browser launch')};await import(${JSON.stringify(pathToFileURL(join(root, "src/cli.mjs")).href)});`,
    );
    let interruptedAt;
    const result = await new Promise((resolve) => {
      const child = execFile(
        process.execPath,
        [bootstrap, "media-discover", ...(signalName === "SIGINT" ? [] : ["all"])],
        { timeout: 5000 },
        (error, stdout, stderr) =>
          resolve({ code: error?.code ?? 0, signal: error?.signal, stdout, stderr }),
      );
      let sent = false;
      child.stdout.on("data", (data) => {
        if (!sent && data.toString().includes("READY")) {
          sent = true;
          interruptedAt = Date.now();
          child.kill(signalName);
        }
      });
    });
    assert.ok(
      Date.now() - interruptedAt < 1000,
      "actual workflow read must be stopped by owned close, not its expiry",
    );
    assert.equal(result.code, 1, result.stderr);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, "");
    const report = JSON.parse(result.stdout.replace(/^READY\n/, ""));
    assert.equal(report.failureCode, "MEDIA_INTERRUPTED");
    assert.equal(report.cleanup, "confirmed");
    assert.equal(report.notAttempted.length, 1);
    assert.deepEqual(JSON.parse(await readFile(marker)), { closed: true });
    await assert.rejects(lstat(mediaQueueLockPath(config.statePath)), { code: "ENOENT" });
  });
