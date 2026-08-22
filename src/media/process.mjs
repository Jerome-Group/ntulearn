import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import { clearTimeout, setTimeout } from "node:timers";

export function runMediaProcess(command, argumentsFor, { signal = null, timeoutMs, label }) {
  if (signal?.aborted) return Promise.reject(interruptionFor(signal, label));
  return new Promise((resolve, reject) => {
    const child = spawn(command, argumentsFor, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    const abort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", (error) => {
      finish(
        reject,
        new Error(
          `${label} could not start: ${error.code ?? "spawn error"}. Check the configured executable, then retry the media worker.`,
        ),
      );
    });
    child.once("close", (code, terminationSignal) => {
      if (signal?.aborted) {
        return finish(reject, interruptionFor(signal, label));
      }
      if (timedOut) {
        return finish(
          reject,
          new Error(
            `${label} timed out. Check the provider and runtime, then retry the media worker.`,
          ),
        );
      }
      if (code === 0) {
        return finish(resolve, {
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
      }
      const suffix = terminationSignal ? ` (${terminationSignal})` : ` (exit ${code})`;
      return finish(
        reject,
        new Error(
          `${label} failed${suffix}. Check the provider and runtime, then retry the media worker.`,
        ),
      );
    });

    function finish(callback, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      callback(value);
    }
  });
}

function interruptionFor(signal, label) {
  return signal.reason ?? new Error(`${label} interrupted. Retry in the next media worker window.`);
}
