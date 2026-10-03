import { createRequire } from "node:module";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import { openClient } from "../../src/ntulearn/client.mjs";
import { createProductionJobRunner, runProductionMedia } from "../../src/media/production.mjs";
import { writeMediaQueue } from "../../src/media/queue.mjs";

async function runSignalFixture(root, mode) {
  const require = createRequire(import.meta.url);
  const { utils } = require(require.resolve("playwright-core/lib/coreBundle"));
  const controller = new globalThis.AbortController();
  const interrupt = () => {
    controller.abort(
      Object.assign(new Error("Owned fixture interruption."), { code: "MEDIA_INTERRUPTED" }),
    );
    process.send?.({ interrupted: true });
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  const originalLaunch = chromium.launchPersistentContext;
  let browser;
  let capture;
  const page = {
    on: (_event, callback) => {
      capture = callback;
    },
    goto: async () => capture({ headers: () => ({ "x-blackboard-xsrf": "owned-fixture-token" }) }),
    waitForURL: async () => {},
  };
  // Installed before any session API runs: this launches Node, never Chromium or an upstream request.
  chromium.launchPersistentContext = async (_profile, options) => {
    browser = await utils.launchProcess({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      env: process.env,
      stdio: "pipe",
      tempDirectories: [],
      log: () => {},
      onExit: () => {},
      handleSIGINT: options.handleSIGINT ?? true,
      handleSIGTERM: options.handleSIGTERM ?? true,
      handleSIGHUP: options.handleSIGHUP ?? true,
      attemptToGracefullyClose: async () => {
        child.kill("SIGTERM");
      },
    });
    const child = browser.launchedProcess;
    return {
      pages: () => [page],
      close: async () => {
        await browser.gracefullyClose();
        await writeFile(join(root, "browser-closed"), "settled");
        if (mode === "cleanup-failure") throw new Error("Owned fixture cleanup failure.");
      },
    };
  };
  try {
    const course = {
      key: "FIXTURE",
      courseId: "_1_1",
      mediaMode: "active",
      destination: join(root, "course"),
    };
    await mkdir(course.destination);
    const config = {
      statePath: join(root, "state.json"),
      profilePath: join(root, "empty-owned-profile"),
      courses: [course],
      media: {
        mediaRoot: join(root, "media"),
        tools: { ffprobe: "unused", ytDlp: "unused" },
        setup: {
          mediaTool: { filename: "unused" },
          asr: {
            runtime: { filename: "unused", revision: "v1.0.0" },
            model: {
              filename: "unused",
              name: "fixture",
              revision: "fixture-revision",
              sha256: "0".repeat(64),
              license: "MIT",
            },
          },
          formatter: {
            runtime: { filename: "unused", revision: "v1.0.0" },
            model: { filename: "unused", revision: "fixture-revision" },
          },
        },
      },
    };
    await writeMediaQueue({
      statePath: config.statePath,
      course,
      discovery: {
        complete: true,
        verdict: "green",
        queue: [
          {
            recordingId: "content-tree:_1_1:owned-fixture",
            provider: "direct",
            disposition: "recording",
            storageSurface: "content-tree",
            placement: {
              destination: course.destination,
              statusPath: "lecture.media-status.md",
              formattedTranscriptPath: "lecture.transcript.md",
            },
          },
        ],
      },
    });
    const result = await runProductionMedia({
      config,
      mode: "manual",
      signal: controller.signal,
      verifyRuntime: async () => ({ runtime: { bin: root, models: root } }),
      createCapacity: async () => ({ check: async () => {}, checkJob: async () => {} }),
      createJobRunner: async (composition) => {
        const runner = await createProductionJobRunner({
          ...composition,
          createStorage: () => ({}),
          ...(mode === "default" ? { open: (profile) => openClient(profile) } : {}),
        });
        return {
          close: runner.close,
          run: async (_job, { signal }) => {
            process.send({ ready: true, ownedChildPid: browser.launchedProcess.pid });
            await new Promise((resolve) =>
              signal.addEventListener("abort", resolve, { once: true }),
            );
            await delay(100);
            await writeFile(join(root, "checkpoint-settled"), "retained");
            throw signal.reason;
          },
        };
      },
    });
    process.stdout.write(JSON.stringify(result.digest) + "\n");
    process.exitCode = result.exitCode;
  } catch (error) {
    process.stderr.write(`${error.code ?? "FIXTURE_FAILED"}\n`);
    process.exitCode = 1;
  } finally {
    chromium.launchPersistentContext = originalLaunch;
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    process.disconnect?.();
  }
}

if (process.argv[2] && process.argv[3]) await runSignalFixture(process.argv[2], process.argv[3]);
