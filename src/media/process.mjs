import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import { clearTimeout, setTimeout } from "node:timers";

export const MEDIA_PROCESS_LIMITS = Object.freeze({
  stdoutMaxBytes: 8 * 1024 * 1024,
  stderrMaxBytes: 256 * 1024,
  graceMs: 250,
  cleanupMs: 1_000,
});

export function runMediaProcess(command, argumentsFor, options) {
  const { signal = null, timeoutMs, label, signalProcessGroup } = options;
  if (signal?.aborted) return Promise.reject(interruptionFor(signal, label));
  const limits = { ...MEDIA_PROCESS_LIMITS, ...options };
  if (
    typeof signalProcessGroup !== "function" ||
    ![
      timeoutMs,
      limits.stdoutMaxBytes,
      limits.stderrMaxBytes,
      limits.graceMs,
      limits.cleanupMs,
    ].every((value) => Number.isSafeInteger(value) && value > 0)
  ) {
    return Promise.reject(
      new Error(
        `${label} needs bounded output and owned process-group cleanup. Check the media runtime composition, then retry.`,
      ),
    );
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, argumentsFor, {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = { stdout: [], stderr: [] };
    const bytes = { stdout: 0, stderr: 0 };
    const timers = new Set();
    let settled = false;
    let stopping = false;
    let closed = false;
    let confirmationScheduled = false;
    let confirmationError;
    let failure;
    let result;
    schedule(
      () =>
        stop(
          new Error(
            `${label} timed out. Check the provider and runtime, then retry the media worker.`,
          ),
        ),
      timeoutMs,
    );
    const abort = () => stop(interruptionFor(signal, label));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    for (const stream of ["stdout", "stderr"]) {
      child[stream].on("data", (chunk) => {
        if (stopping || settled) return;
        bytes[stream] += chunk.length;
        if (bytes[stream] > limits[`${stream}MaxBytes`]) {
          const error = new Error(
            `${label} exceeded its ${stream} byte limit. Check the runtime output or increase its explicit bound, then retry the media worker.`,
          );
          error.code = "MEDIA_OUTPUT_LIMIT";
          stop(error);
        } else output[stream].push(chunk);
      });
    }
    child.once("error", (error) => {
      if (!child.pid)
        return finish(
          new Error(
            `${label} could not start: ${error.code ?? "spawn error"}. Check the configured executable, then retry the media worker.`,
            { cause: error },
          ),
        );
      stop(error);
    });
    child.once("close", (code, terminationSignal) => {
      if (settled) return;
      closed = true;
      if (stopping) return confirmGroupCleanup();
      if (code === 0)
        result = {
          stdout: Buffer.concat(output.stdout).toString("utf8"),
          stderr: Buffer.concat(output.stderr).toString("utf8"),
        };
      else
        failure = new Error(
          `${label} failed (${terminationSignal ?? `exit ${code}`}). Check the provider and runtime, then retry the media worker.`,
        );
      try {
        if (signalProcessGroup(child.pid, 0)) return stop(failure);
      } catch (error) {
        return finish(groupCleanupFailure(error));
      }
      finish(failure);
    });

    function schedule(callback, delay) {
      const timer = setTimeout(() => {
        timers.delete(timer);
        callback();
      }, delay);
      timers.add(timer);
    }

    function stop(reason) {
      if (settled || stopping) return;
      stopping = true;
      failure = reason;
      try {
        signalProcessGroup(child.pid, "SIGTERM");
      } catch (error) {
        return finish(groupCleanupFailure(error));
      }
      schedule(() => {
        try {
          if (signalProcessGroup(child.pid, 0)) signalProcessGroup(child.pid, "SIGKILL");
        } catch (error) {
          return finish(groupCleanupFailure(error));
        }
        schedule(() => finish(groupCleanupFailure(confirmationError)), limits.cleanupMs);
        confirmGroupCleanup();
      }, limits.graceMs);
      confirmGroupCleanup();
    }

    function confirmGroupCleanup() {
      if (settled) return;
      try {
        if (closed && !signalProcessGroup(child.pid, 0)) return finish(failure);
      } catch (error) {
        if (error.code !== "EPERM") return finish(groupCleanupFailure(error));
        confirmationError = error;
      }
      if (!confirmationScheduled) {
        confirmationScheduled = true;
        schedule(() => {
          confirmationScheduled = false;
          confirmGroupCleanup();
        }, 20);
      }
    }

    function groupCleanupFailure(cause) {
      const error = new Error(
        `${label} owned process-group cleanup could not be confirmed. Stop the media worker and inspect the owned runtime processes before retrying; temporary files were preserved.`,
        { cause },
      );
      error.code = "MEDIA_PROCESS_CLEANUP";
      error.globalSafety = true;
      return error;
    }

    function finish(error) {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      child.stdout.destroy();
      child.stderr.destroy();
      if (error?.code === "MEDIA_PROCESS_CLEANUP") child.unref();
      if (error) reject(error);
      else resolve(result);
    }
  });
}

function interruptionFor(signal, label) {
  return signal.reason ?? new Error(`${label} interrupted. Retry in the next media worker window.`);
}
