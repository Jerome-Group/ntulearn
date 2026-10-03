import { persistMediaSafetyBarrier } from "./safety.mjs";
import { withCapacityDeadline } from "./capacity-deadline.mjs";
import { createMediaCapacity } from "./capacity.mjs";
import { withMediaQueueLock } from "./lock.mjs";
import { markGlobalMediaSafety } from "./errors.mjs";
import { join } from "node:path";
import { openClient } from "../ntulearn/client.mjs";
import { runMediaProcess } from "./process.mjs";
import { runMediaJob } from "./job.mjs";
import { createProductionLocalModels } from "./production-local.mjs";
import { createProductionProviders } from "./production-providers.mjs";
import { verifyMediaRuntime } from "./setup.mjs";
import { createMediaStorage } from "./storage.mjs";
import { mediaWorkerExitCode, runMediaQueue } from "./worker.mjs";

export async function runProductionMedia({
  config,
  signalProcessGroup,
  mode = "scheduled",
  priorityCourseKey = null,
  signal,
  verifyRuntime = verifyMediaRuntime,
  createCapacity = createMediaCapacity,
  capacityCheckTimeoutMs = 5_000,
  createJobRunner = createProductionJobRunner,
  lock,
  write,
  now,
  clock,
  timeZone,
  readQueue,
  updateJob,
}) {
  let runtime;
  let capacity;
  let runner;
  let settlement;
  const closeJobRunner = () =>
    (settlement ??= Promise.resolve().then(async () => {
      try {
        await runner?.close?.();
      } catch (cause) {
        const error = markGlobalMediaSafety(
          Object.assign(
            new Error(
              "Media browser cleanup is unconfirmed. Inspect the owned session before retrying.",
              { cause },
            ),
            { code: "MEDIA_BROWSER_CLEANUP" },
          ),
        );
        await persistMediaSafetyBarrier({ statePath: config.statePath, error, now });
        throw error;
      }
    }));
  const queueLock = lock === undefined ? withMediaQueueLock : lock;
  const settledLock = queueLock
    ? (options) =>
        queueLock({
          ...options,
          run: async () => {
            try {
              return await options.run();
            } finally {
              await closeJobRunner();
            }
          },
        })
    : null;
  const preflight = async () => {
    signal?.throwIfAborted();
    runtime = await verifyRuntime(config.media, { signalProcessGroup, signal });
    signal?.throwIfAborted();
    capacity = await withCapacityDeadline(
      () =>
        createCapacity(config.media, {
          courses: config.courses,
          timeoutMs: capacityCheckTimeoutMs,
        }),
      { timeoutMs: capacityCheckTimeoutMs },
    );
    signal?.throwIfAborted();
  };
  const runJob = async (appearance, context) => {
    context.signal?.throwIfAborted();
    if (appearance.provider === "unsupported") return unsupportedResult(appearance);
    runner ??= await createJobRunner({
      config,
      runtime,
      capacity,
      capacityCheckTimeoutMs,
      signalProcessGroup,
    });
    context.signal?.throwIfAborted();
    return runner.run(appearance, context);
  };

  try {
    const digest = await runMediaQueue({
      statePath: config.statePath,
      courses: config.courses,
      media: config.media,
      mode,
      priorityCourseKey,
      signal,
      preflight,
      checkCapacity: ({ course }) => capacity.checkJob(course),
      capacityCheckTimeoutMs,
      runJob,
      closeJobRunner,
      lock: settledLock,
      ...(write === undefined ? {} : { write }),
      ...(now === undefined ? {} : { now }),
      ...(clock === undefined ? {} : { clock }),
      ...(timeZone === undefined ? {} : { timeZone }),
      ...(readQueue === undefined ? {} : { readQueue }),
      ...(updateJob === undefined ? {} : { updateJob }),
    });
    return { digest, exitCode: mediaWorkerExitCode(digest) };
  } finally {
    await closeJobRunner();
  }
}

export async function createProductionJobRunner({
  config,
  runtime,
  capacity,
  capacityCheckTimeoutMs,
  signalProcessGroup,
  open = openClient,
}) {
  if (!runtime?.runtime) {
    throw new Error(
      "Production media composition needs a verified runtime. Run: npm run media:setup",
    );
  }
  const context = productionContext(config, runtime.runtime, signalProcessGroup);
  const providers = createProductionProviders(context);
  const local = createProductionLocalModels(context);
  const storage = createMediaStorage({
    mediaRoot: config.media.mediaRoot,
    checkCapacity: capacity.check,
    capacityCheckTimeoutMs,
  });
  const client = await open(config.profilePath);

  return {
    async run(appearance, jobContext) {
      const composition = providers[appearance.provider];
      if (!composition) return unsupportedResult(appearance);
      const execute = (provider) =>
        runMediaJob({
          appearance,
          provider,
          storage,
          formatter: local.formatter,
          transcriber: local.transcriber,
          signal: jobContext.signal,
          clock: jobContext.now,
        });
      return composition.browser
        ? client.withBrowserPage((page) => execute(composition.create(page)))
        : execute(composition.create());
    },
    close: () => client.close(),
  };
}

function productionContext(config, paths, signalProcessGroup) {
  const setup = config.media.setup;
  return {
    setup,
    paths,
    runProcess: (command, argumentsFor, options) =>
      runMediaProcess(command, argumentsFor, { ...options, signalProcessGroup }),
    commands: {
      ffmpeg: join(paths.bin, setup.mediaTool.filename),
      ffprobe: config.media.tools.ffprobe,
      whisper: join(paths.bin, setup.asr.runtime.filename),
      llama: join(paths.bin, setup.formatter.runtime.filename),
      ytDlp: config.media.tools.ytDlp,
    },
    models: {
      asr: join(paths.models, setup.asr.model.filename),
      formatter: join(paths.models, setup.formatter.model.filename),
    },
  };
}

function unsupportedResult(appearance) {
  const limitation =
    appearance.limitation ?? "Unsupported recording provider shape; acquisition is unavailable.";
  return {
    complete: false,
    stage: "failed",
    verdict: "red",
    retryable: false,
    limitations: [`${limitation} Run media discovery again after a provider adapter is added.`],
  };
}
