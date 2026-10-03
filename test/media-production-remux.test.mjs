import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout } from "node:timers/promises";
import test from "node:test";
import { remuxDirect, remuxKaltura, remuxYoutube } from "../src/media/production-remux.mjs";
import { MEDIA_PROCESS_LIMITS, runMediaProcess } from "../src/media/process.mjs";

const routes = [
  ["Kaltura", remuxKaltura, ["-c", "copy", "-movflags", "+faststart"]],
  ["direct", remuxDirect, ["-c", "copy", "-movflags", "+faststart"]],
  [
    "YouTube",
    remuxYoutube,
    ["-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"],
  ],
];

function group(pid, signal) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "ntulearn-remux-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const work = join(root, "work"),
    download = join(work, "download");
  await mkdir(download, { recursive: true });
  const path = join(download, "input.mp4"),
    original = join(root, "original.mp4");
  await writeFile(path, "owned download");
  await writeFile(original, "original bytes");
  return {
    root,
    work,
    download,
    original,
    downloaded: { path, directory: download, url: "https://fixture.invalid/signed?ks=private" },
  };
}

for (const [name, remux, codecs] of routes) {
  test(`${name} remux retains warning/error diagnostics and codec/audio behavior under finite bounds`, async (t) => {
    const f = await fixture(t);
    let captured;
    const result = await remux(
      f.downloaded,
      {},
      {
        paths: { work: f.work },
        commands: { ffmpeg: "owned fixture" },
        runProcess: async (_command, args, options) => {
          captured = options;
          assert.deepEqual(args.slice(0, 6), [
            "-hide_banner",
            "-loglevel",
            "warning",
            "-nostats",
            "-y",
            "-i",
          ]);
          assert.deepEqual(args.slice(7, -1), codecs);
          await writeFile(args.at(-1), "owned remux");
          return { stdout: "", stderr: "retained warning diagnostic" };
        },
      },
    );
    assert.equal(captured.timeoutMs, 4 * 60 * 60 * 1000);
    assert.equal(captured.stdoutMaxBytes, undefined);
    assert.equal(captured.stderrMaxBytes, undefined);
    assert.equal(MEDIA_PROCESS_LIMITS.stderrMaxBytes, 256 * 1024);
    assert.equal(MEDIA_PROCESS_LIMITS.stdoutMaxBytes, 8 * 1024 * 1024);
    assert.equal(result.audio, true);
    assert.equal(await readFile(result.path, "utf8"), "owned remux");
    assert.ok(!JSON.stringify(result).includes("retained warning diagnostic"));
    await result.cleanup();
    assert.equal(await readFile(f.original, "utf8"), "original bytes");
  });

  for (const scenario of [
    "native-error",
    "warning-overflow",
    "interrupt",
    "cleanup-unconfirmed",
    "missing-group-verifier",
  ]) {
    test(`${name} remux ${scenario} refuses without raw diagnostics and preserves originals`, async (t) => {
      const f = await fixture(t);
      const controller = new globalThis.AbortController();
      const ready = join(f.root, "ready");
      const script =
        scenario === "interrupt"
          ? `require('fs').writeFileSync(process.argv[1], 'ready'); setInterval(()=>{},1000)`
          : scenario === "warning-overflow"
            ? `process.stderr.write('private-native-diagnostic '.repeat(20000));`
            : `process.stderr.write('private-native-diagnostic https://fixture.invalid/signed?ks=private');process.exit(7)`;
      let outputDirectory;
      const operation = remux(
        f.downloaded,
        { signal: controller.signal },
        {
          paths: { work: f.work },
          commands: { ffmpeg: "owned fixture" },
          runProcess: (_command, args, options) => {
            outputDirectory = dirname(args.at(-1));
            return runMediaProcess(process.execPath, ["-e", script, ready], {
              ...options,
              timeoutMs: 3000,
              signalProcessGroup:
                scenario === "missing-group-verifier"
                  ? undefined
                  : scenario === "cleanup-unconfirmed"
                    ? () => {
                        throw new Error("owned verifier refusal");
                      }
                    : group,
            });
          },
        },
      );
      // Attach rejection immediately while readiness is observed.
      const assertion = assert.rejects(operation, (error) => {
        assert.ok(!error.message.includes("private-native-diagnostic"));
        assert.ok(!error.message.includes("ks=private"));
        assert.ok(!error.message.includes(f.root));
        if (scenario === "native-error") assert.match(error.message, /exit 7/);
        if (scenario === "warning-overflow") assert.equal(error.code, "MEDIA_OUTPUT_LIMIT");
        if (scenario === "interrupt") assert.equal(error, controller.signal.reason);
        if (scenario === "cleanup-unconfirmed") {
          assert.equal(error.code, "MEDIA_PROCESS_CLEANUP");
          assert.equal(error.globalSafety, true);
        }
        if (scenario === "missing-group-verifier")
          assert.match(error.message, /owned process-group cleanup/);
        return true;
      });
      if (scenario === "interrupt") {
        for (let attempts = 0; ; attempts++) {
          try {
            await readFile(ready);
            break;
          } catch {
            assert.ok(attempts < 100, "owned child did not become ready");
            await setTimeout(10);
          }
        }
        controller.abort(new Error("Owned interruption; retry after checkpoint"));
      }
      await assertion;
      assert.equal(await readFile(f.original, "utf8"), "original bytes");
      if (scenario === "cleanup-unconfirmed") {
        assert.ok((await stat(outputDirectory)).isDirectory());
        assert.equal(await readFile(f.downloaded.path, "utf8"), "owned download");
      } else
        await assert.rejects(readFile(join(outputDirectory, "recording.mp4")), { code: "ENOENT" });
    });
  }
}

test("already retained direct media needs no remux and remains untouched", async (t) => {
  const f = await fixture(t);
  const result = await remuxDirect(
    { ...f.downloaded, retained: true },
    { representation: { kind: "audio" } },
    {
      runProcess: () => assert.fail("retained input must not run FFmpeg"),
    },
  );
  assert.equal(result.path, f.downloaded.path);
  assert.equal(result.audio, true);
  assert.equal(await readFile(result.path, "utf8"), "owned download");
});
