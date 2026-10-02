import { clearTimeout, setTimeout } from "node:timers";
import { createRuntimeCommandRunner, RUNTIME_COMMAND_TIMEOUT_MS } from "./runtime-command.mjs";

export const RUNTIME_VERIFICATION_TIMEOUT_MS = 120_000;

export function createRuntimeVerification(fileSystem, options = {}) {
  const timeoutMs = options.verificationTimeoutMs ?? RUNTIME_VERIFICATION_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    throw new Error(
      "Runtime verification needs a positive read deadline. Repair the runtime options, then retry.",
    );
  const clock = options.clock ?? (() => Date.now());
  const deadline = clock() + timeoutMs;
  let expired;
  function remaining() {
    if (expired || clock() >= deadline) {
      expired ??= timeoutFailure();
      throw expired;
    }
    return Math.max(1, deadline - clock());
  }
  async function read(operation) {
    const budget = remaining();
    let timer;
    try {
      const result = await Promise.race([
        Promise.resolve().then(operation),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            expired ??= timeoutFailure();
            reject(expired);
          }, budget);
        }),
      ]);
      remaining();
      return result;
    } finally {
      clearTimeout(timer);
    }
  }
  const guarded = {};
  for (const method of ["stat", "lstat", "realpath", "readFile", "statfs"])
    guarded[method] = (...args) => read(() => fileSystem[method](...args));
  const runner = options.commandRunner ?? createRuntimeCommandRunner(options);
  return {
    fileSystem: guarded,
    read,
    assertActive: remaining,
    commandRunner: async (command, args) => {
      const budget = remaining();
      const result = await runner(command, args, {
        timeoutMs: Math.min(options.commandTimeoutMs ?? RUNTIME_COMMAND_TIMEOUT_MS, budget),
      });
      remaining();
      return result;
    },
  };
}

function timeoutFailure() {
  const error = new Error(
    "Read-only media runtime verification timed out. Restore the mounted runtime store or resolve stalled filesystem reads, then retry; acquisition was not permitted. Pending OS reads may remain unresolved.",
  );
  error.code = "MEDIA_RUNTIME_TIMEOUT";
  error.globalSafety = true;
  return error;
}
