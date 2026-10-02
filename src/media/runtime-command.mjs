import { execFile } from "node:child_process";
import { clearTimeout, setTimeout } from "node:timers";
import { runMediaProcess } from "./process.mjs";

export const RUNTIME_COMMAND_TIMEOUT_MS = 30_000;
const OUTPUT_BYTES = 1024 * 1024;

export function createRuntimeCommandRunner(options = {}) {
  return async (command, args, limits = {}) => {
    const timeoutMs = limits.timeoutMs ?? options.commandTimeoutMs ?? RUNTIME_COMMAND_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
      throw new Error(
        "Runtime verification needs a positive command timeout. Repair the runtime options, then retry.",
      );
    if (options.signalProcessGroup) {
      await runMediaProcess(command, args, {
        ...options,
        ...limits,
        timeoutMs,
        label: "Media runtime verification",
        stdoutMaxBytes: OUTPUT_BYTES,
        stderrMaxBytes: OUTPUT_BYTES,
      });
    } else {
      await runLeader(command, args, timeoutMs);
    }
    return { code: 0 };
  };
}

// Library callers have no process-group authority. Only the direct child is stopped here;
// production and the Owner CLI supply the owned-group runner instead.
function runLeader(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = execFile(
      command,
      args,
      {
        encoding: "utf8",
        maxBuffer: OUTPUT_BYTES,
        timeout: timeoutMs,
        killSignal: "SIGKILL",
      },
      (error) => finish(error),
    );
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      child.stdout?.destroy();
      child.stderr?.destroy();
      finish(
        new Error(
          "Runtime command exceeded its deadline; only direct-child termination was requested.",
        ),
      );
    }, timeoutMs);
    function finish(cause) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!cause) return resolve();
      const error = new Error(
        "Media runtime verification failed or timed out. Check the configured executable and runtime processes, then retry; direct API calls do not confirm descendant cleanup.",
        { cause },
      );
      error.code = cause.code ?? "MEDIA_RUNTIME_COMMAND";
      reject(error);
    }
  });
}
