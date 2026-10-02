import { performance } from "node:perf_hooks";
export function createEvaluationProcess({
  runProcess,
  memoryMeasurement = null,
  timeoutMs,
  signal,
  onStage,
}) {
  if (memoryMeasurement !== null && memoryMeasurement !== "darwin-time")
    throw new Error(
      "Memory measurement is unsupported. Select darwin-time only with the installed macOS time tool, or leave measurement unrun.",
    );
  return async (command, argumentsFor, options) => {
    const startedAt = performance.now();
    const combined =
      options.signal && signal
        ? globalThis.AbortSignal.any([options.signal, signal])
        : (options.signal ?? signal);
    try {
      const result = await runProcess(
        memoryMeasurement === "darwin-time" ? "/usr/bin/time" : command,
        memoryMeasurement === "darwin-time" ? ["-l", command, ...argumentsFor] : argumentsFor,
        {
          ...options,
          signal: combined,
          timeoutMs: Math.min(timeoutMs, options.timeoutMs ?? timeoutMs),
        },
      );
      const records =
        memoryMeasurement === "darwin-time"
          ? [...String(result.stderr ?? "").matchAll(/^\s*(\d+)\s+maximum resident set size\s*$/gm)]
          : [];
      const candidate = records.length === 1 ? Number(records[0][1]) : null;
      const observed = Number.isSafeInteger(candidate) && candidate > 0 ? candidate : null;
      onStage({
        stage: options.label,
        flags: safeArguments(argumentsFor),
        wallMs: Math.round(performance.now() - startedAt),
        status: "passed",
        maxRssBytes: observed,
        memoryStatus: observed ? "passed" : "unrun",
      });
      return result;
    } catch (error) {
      onStage({
        stage: options.label,
        flags: safeArguments(argumentsFor),
        wallMs: Math.round(performance.now() - startedAt),
        status: "failed",
        maxRssBytes: null,
        memoryStatus: "unrun",
      });
      throw error;
    }
  };
}

function safeArguments(values) {
  return values.map((value) =>
    /^-[a-z][a-z-]*$/i.test(value) ||
    /^\d+(?:\.\d+)?$/.test(value) ||
    ["auto", "en", "flac", "off"].includes(value)
      ? value
      : "<private-input>",
  );
}
