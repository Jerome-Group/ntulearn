import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const jarSha256 = "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88";
export const jarPath = resolve(process.env.TLA2TOOLS_JAR ?? ".scratch/formal-tools/tla2tools.jar");
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function verifyJar() {
  const jar = await readFile(jarPath).catch(() => {
    throw new Error(
      "TLC jar missing. Run: node .agents/skills/additive-publication/scripts/setup.mjs",
    );
  });
  if (sha256(jar) !== jarSha256) {
    throw new Error(
      `TLC jar SHA-256 mismatch at ${jarPath}. Restore pinned tools distribution 1.7.4 with setup.mjs.`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const response = await globalThis.fetch(
    "https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar",
  );
  if (!response.ok)
    throw new Error(
      `TLC download failed (${response.status}). Retry setup.mjs with network access.`,
    );
  const bytes = Buffer.from(await response.arrayBuffer());
  if (sha256(bytes) !== jarSha256)
    throw new Error("TLC download SHA-256 mismatch. Keep the pin and inspect the release.");
  await mkdir(dirname(jarPath), { recursive: true });
  await writeFile(jarPath, bytes, { mode: 0o600 });
  console.log(`Pinned tools distribution 1.7.4 saved at ${jarPath}. Use Java 11 or later.`);
}
