import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.mjs";
import { openNtulearn } from "./ntulearn.mjs";
import { readState, syncConfiguredCourse, writeState } from "./sync.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const config = await loadConfig(root);
const [command, argument] = process.argv.slice(2);

if (command === "login") {
  const session = await openNtulearn(config.profilePath, { headless: false });
  const page = await session.page();
  console.log("Complete NTU SSO/MFA in Chrome, then return here.");
  const prompt = createInterface({ input: stdin, output: stdout });
  await prompt.question("Press Enter after the NTULearn Courses page appears... ");
  prompt.close();
  console.log(`Session page: ${page.url()}`);
  await session.close();
  process.exit(0);
}

if (command === "discover") {
  const client = await openNtulearn(config.profilePath);
  try {
    console.log(JSON.stringify(await client.discoverCourses(), null, 2));
  } finally {
    await client.close();
  }
  process.exit(0);
}

if (command === "sync") {
  const selected = !argument || argument === "all"
    ? config.courses
    : config.courses.filter((course) => course.key.toLowerCase() === argument.toLowerCase());
  if (!selected.length) throw new Error(`Unknown module: ${argument}`);

  const client = await openNtulearn(config.profilePath);
  const state = await readState(config.statePath);
  const results = [];
  try {
    for (const course of selected) {
      const result = await syncConfiguredCourse({ client, config: course, state });
      results.push(result);
      await writeState(config.statePath, state);
    }
  } finally {
    await client.close();
  }
  console.log(JSON.stringify(results, null, 2));
  if (results.some((result) => result.failures.length)) process.exitCode = 1;
  process.exit();
}

console.error("Usage: npm run login | npm run discover | npm run sync -- <module|all>");
process.exitCode = 1;
