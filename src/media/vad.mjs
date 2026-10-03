import { realpath } from "node:fs/promises";
import { withEvaluationRead } from "./evaluation-read.mjs";
import { assertRecoveryInputs } from "./recovery-manifest.mjs";
import { join } from "node:path";
import { createRuntimeCommandRunner } from "./runtime-command.mjs";
import { recoveryFile, recoveryFailure } from "./recovery-files.mjs";

import {
  VAD_RUNTIME,
  VAD_MODEL,
  VAD_CONTROLS,
  VAD_DELEGATE,
  vadRuntimePin,
  vadDelegateRuntimePin,
} from "./vad-model.mjs";
export { VAD_RUNTIME, VAD_MODEL, VAD_CONTROLS } from "./vad-model.mjs";

export const vadPaths = (runtime) => ({
  model: join(runtime.models, VAD_MODEL.filename),
  journal: join(runtime.metadata, "recovery-vad-setup.json"),
  receipt: join(runtime.metadata, "recovery-vad-prepared.json"),
});
const fail = () => recoveryFailure("RECOVERY_VAD_UNPREPARED");
export const vadPreparationBody = (runtime, spec, delegate) =>
  JSON.stringify(
    {
      schemaVersion: 1,
      purpose: "optional-recovery-vad",
      model: { ...spec, path: vadPaths(runtime).model },
      runtime: VAD_RUNTIME,
      delegate: {
        executionPath: delegate.executionPath,
        canonicalPath: delegate.canonicalPath,
        ...delegate.pin,
      },
    },
    null,
    2,
  ) + "\n";
export async function optionalVadFile(path, signal, maximumBytes = 16384) {
  try {
    return await recoveryFile(path, { signal, maximumBytes });
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
export async function verifyVadCapabilities(runtime, signal, dependencies) {
  const pin = runtime.artifacts.find((item) => item.key === "asr.runtime");
  const expected = dependencies.runtimePin ?? VAD_RUNTIME;
  if (
    pin?.sha256 !== expected.sha256 ||
    pin?.revision !== expected.revision ||
    !Number.isSafeInteger(pin.bytes) ||
    pin.bytes !== expected.bytes
  )
    throw fail();
  const command = join(runtime.runtime.root, pin.path);
  const before = await recoveryFile(command, { maximumBytes: pin.bytes, signal, retain: true });
  if (before.sha256 !== expected.sha256 || before.bytes !== pin.bytes) throw fail();
  const delegated = dependencies.delegateSpec ?? VAD_DELEGATE;
  const matches = [...before.content.toString("utf8").matchAll(/^exec (\/[^\s"'`]+) "\$@"$/gm)];
  if (matches.length !== 1 || matches[0][1] !== delegated.executionPath) throw fail();
  const canonicalPath = await withEvaluationRead(() => realpath(delegated.executionPath), {
    signal,
  });
  if (canonicalPath !== delegated.canonicalPath) throw fail();
  const binary = await recoveryFile(canonicalPath, {
    maximumBytes: delegated.bytes,
    signal,
    retain: false,
  });
  if (binary.sha256 !== delegated.sha256 || binary.bytes !== delegated.bytes) throw fail();
  const delegate = {
    executionPath: delegated.executionPath,
    canonicalPath,
    pin: vadDelegateRuntimePin(delegated),
    input: { path: binary.path, sha256: binary.sha256, bytes: binary.bytes },
  };
  await assertVadDelegateResolution(delegate, signal);
  const help = await (dependencies.commandRunner ?? createRuntimeCommandRunner(dependencies))(
    command,
    ["--help"],
    { captureOutput: true },
  );
  signal?.throwIfAborted();
  const tokens = new Set(
    String(help.stdout ?? "")
      .concat("\n", help.stderr ?? "")
      .match(/--[a-z][a-z-]*/g) ?? [],
  );
  if (
    help.code !== 0 ||
    [
      "--vad",
      "--vad-model",
      "--suppress-nst",
      ...VAD_CONTROLS.filter((arg) => arg.startsWith("--")),
    ].some((arg) => !tokens.has(arg))
  )
    throw fail();
  const file = await recoveryFile(command, { maximumBytes: pin.bytes, signal, retain: false });
  if (file.sha256 !== expected.sha256 || file.bytes !== pin.bytes) throw fail();
  await assertRecoveryInputs({ protectedInputs: [delegate.input] }, signal);
  await assertVadDelegateResolution(delegate, signal);
  return { path: file.path, sha256: file.sha256, bytes: file.bytes, delegate };
}
export async function verifyRecoveryVad({ runtime, signal }, dependencies = {}) {
  const spec = dependencies.spec ?? VAD_MODEL;
  const executable = await verifyVadCapabilities(runtime, signal, dependencies);
  const paths = vadPaths(runtime.runtime);
  const expected = vadPreparationBody(runtime.runtime, spec, executable.delegate);
  const inputs = [executable, executable.delegate.input];
  for (const path of [paths.journal, paths.receipt]) {
    const file = await optionalVadFile(path, signal);
    if (!file) throw fail();
    if (file.content.toString("utf8") !== expected) throw fail();
    inputs.push({ path, sha256: file.sha256, bytes: file.bytes });
  }
  const file = await optionalVadFile(paths.model, signal, spec.bytes);
  if (!file) throw fail();
  if (file.sha256 !== spec.sha256 || file.bytes !== spec.bytes) throw fail();
  return {
    path: paths.model,
    pin: vadRuntimePin(spec),
    delegatePin: executable.delegate.pin,
    delegate: executable.delegate,
    inputs: [...inputs, { path: file.path, sha256: file.sha256, bytes: file.bytes }],
  };
}

async function assertVadDelegateResolution(delegate, signal) {
  const current = await withEvaluationRead(() => realpath(delegate.executionPath), { signal });
  if (current !== delegate.canonicalPath) throw fail();
}

export async function assertRecoveryVadInputs(vad, signal) {
  if (vad.delegate) await assertVadDelegateResolution(vad.delegate, signal);
  await assertRecoveryInputs({ protectedInputs: vad.inputs }, signal);
  if (vad.delegate) await assertVadDelegateResolution(vad.delegate, signal);
}
