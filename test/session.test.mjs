import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { openLoginWindow, openSignedInContext } from "../src/ntulearn/session.mjs";

for (const [name, openContext] of [
  ["login", openLoginWindow],
  ["signed-in", openSignedInContext],
]) {
  test(`${name} rejects a URL-encoded profile path before creating a second profile`, async () => {
    const root = await mkdtemp(join(tmpdir(), "ntulearn-session-"));
    const profile = join(root, "profile with spaces");
    const encodedPath = pathToFileURL(profile).pathname;

    assert.match(encodedPath, /%20/);
    await assert.rejects(openContext(encodedPath), /URL-encoded/);
    await assert.rejects(stat(profile), { code: "ENOENT" });
  });
}
