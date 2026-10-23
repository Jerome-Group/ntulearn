import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [mirror, fixture, scenario, output] = process.argv.slice(2);
const { configure, asWriter, occupant, events } = await import(
  pathToFileURL(join(mirror, "native-fs.mjs"))
);
const { writeWithoutReplacing } = await import(pathToFileURL(join(mirror, "src/sync/files.mjs")));
const destination = join(fixture, "course.md");
const a = Buffer.from("Writer A complete body\n");
const b = Buffer.from("Writer B complete body\n");
const existing = Buffer.from("Student annotation\n");
const race = scenario === "different" || scenario === "same";
if (scenario.startsWith("occupied")) {
  await writeFile(destination, scenario === "occupied-same" ? a : existing);
}
if (scenario === "directory") await mkdir(destination);
if (scenario === "symlink") await symlink("student-target", destination);
const before = await occupant(destination);
configure(destination, race);
const publish = (id, body) =>
  asWriter(id, async () => {
    try {
      return { writer: id, value: await writeWithoutReplacing(destination, body) };
    } catch (error) {
      return { writer: id, error: error.code ?? error.message };
    }
  });
const outcomes = await Promise.all([
  publish("A", a),
  ...(race ? [publish("B", scenario === "same" ? a : b)] : []),
]);
const after = await occupant(destination);
const trace = events();
const first = before.kind === "absent" ? trace.find((event) => event.occupant)?.occupant : before;
const violations = [];
if (first && JSON.stringify(first) !== JSON.stringify(after)) {
  violations.push({ invariant: "FirstOccupantPreserved", expected: first, actual: after });
}
for (const outcome of outcomes.filter((item) => typeof item.value === "boolean")) {
  const accepted =
    trace.find((event) => event.writer === outcome.writer && event.occupant)?.occupant ?? after;
  const requested = outcome.writer === "B" && scenario === "different" ? b : a;
  if (accepted.bytes !== requested.toString("base64")) {
    violations.push({
      invariant: "SuccessfulBytesComplete",
      writer: outcome.writer,
      expected: requested.toString("base64"),
      actual: accepted.bytes,
    });
  }
}
const expected = race
  ? [
      { writer: "A", value: true },
      scenario === "same"
        ? { writer: "B", value: false }
        : { writer: "B", error: "SYNC_FILE_CONFLICT" },
    ]
  : [
      {
        writer: "A",
        ...(scenario === "fresh"
          ? { value: true }
          : scenario === "occupied-same"
            ? { value: false }
            : { error: "SYNC_FILE_CONFLICT" }),
      },
    ];
const partials = (await readdir(fixture)).filter((name) => name.includes(".part-"));
await writeFile(
  output,
  JSON.stringify(
    { scenario, before, first, after, outcomes, expected, violations, partials, trace },
    null,
    2,
  ),
);
if (violations.length === 0) {
  assert.deepEqual(outcomes, expected);
  assert.deepEqual(partials, []);
  if (race) {
    const inspections = trace.filter(
      (event) => event.operation === "lstat" && event.result === "ENOENT",
    );
    assert.equal(inspections.length, 2);
    assert.deepEqual(inspections.map((event) => event.writer).sort(), ["A", "B"]);
    assert.equal(trace.find((event) => event.occupant).writer, "A");
  }
}
assert.equal(JSON.parse(await readFile(output, "utf8")).scenario, scenario);
