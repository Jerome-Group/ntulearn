import { join } from "node:path";
import { openClient } from "../ntulearn/client.mjs";
import { runMediaJob } from "./job.mjs";
import { createProductionLocalModels } from "./production-local.mjs";
import { createProductionProviders } from "./production-providers.mjs";
import { verifyMediaRuntime } from "./setup.mjs";
import { createMediaStorage } from "./storage.mjs";
import { mediaWorkerExitCode, runMediaQueue } from "./worker.mjs";

export async function runProductionMedia({
  config,
  mode = "scheduled",
  verifyRuntime = verifyMediaRuntime,
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
  let runner;
  const preflight = async () => {
    runtime = await verifyRuntime(config.media);
  };
  const runJob = async (appearance, context) => {
    if (appearance.provider === "unsupported") return unsupportedResult(appearance);
    runner ??= await createJobRunner({ config, runtime });
    return runner.run(appearance, context);
  };

  try {
    const digest = await runMediaQueue({
      statePath: config.statePath,
      courses: config.courses,
      mode,
      preflight,
      runJob,
      ...(lock === undefined ? {} : { lock }),
      ...(write === undefined ? {} : { write }),
      ...(now === undefined ? {} : { now }),
      ...(clock === undefined ? {} : { clock }),
      ...(timeZone === undefined ? {} : { timeZone }),
      ...(readQueue === undefined ? {} : { readQueue }),
      ...(updateJob === undefined ? {} : { updateJob }),
    });
    return { digest, exitCode: mediaWorkerExitCode(digest) };
  } finally {
    await runner?.close?.();
  }
}

export async function createProductionJobRunner({ config, runtime, open = openClient }) {
  if (!runtime?.runtime) {
    throw new Error(
      "Production media composition needs a verified runtime. Run: npm run media:setup",
    );
  }
  const context = productionContext(config, runtime.runtime);
  const providers = createProductionProviders(context);
  const local = createProductionLocalModels(context);
  const storage = createMediaStorage({ mediaRoot: config.media.mediaRoot });
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

function productionContext(config, paths) {
  const setup = config.media.setup;
  return {
    setup,
    paths,
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
