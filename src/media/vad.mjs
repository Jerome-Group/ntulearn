import { join } from "node:path";
import { createRuntimeCommandRunner } from "./runtime-command.mjs";
import { recoveryFile, recoveryFailure } from "./recovery-files.mjs";

import { VAD_RUNTIME, VAD_MODEL, VAD_CONTROLS, vadRuntimePin } from "./vad-model.mjs";
export { VAD_RUNTIME, VAD_MODEL, VAD_CONTROLS } from "./vad-model.mjs";

export const vadPaths = (runtime) => ({
  model: join(runtime.models, VAD_MODEL.filename),
  journal: join(runtime.metadata, "recovery-vad-setup.json"),
  receipt: join(runtime.metadata, "recovery-vad-prepared.json"),
});
const fail = () => recoveryFailure("RECOVERY_VAD_UNPREPARED");
export const vadPreparationBody = (runtime, spec) =>
  JSON.stringify(
    {
      schemaVersion: 1,
      purpose: "optional-recovery-vad",
      model: { ...spec, path: vadPaths(runtime).model },
      runtime: VAD_RUNTIME,
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
    pin.bytes <= 0
  )
    throw fail();
  const command = join(runtime.runtime.root, pin.path);
  const before = await recoveryFile(command, { maximumBytes: pin.bytes, signal, retain: false });
  if (before.sha256 !== expected.sha256 || before.bytes !== pin.bytes) throw fail();
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
  return { path: file.path, sha256: file.sha256, bytes: file.bytes };
}
export async function verifyRecoveryVad({ runtime, signal }, dependencies = {}) {
  const spec = dependencies.spec ?? VAD_MODEL;
  const executable = await verifyVadCapabilities(runtime, signal, dependencies);
  const paths = vadPaths(runtime.runtime);
  const expected = vadPreparationBody(runtime.runtime, spec);
  const inputs = [executable];
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
    inputs: [...inputs, { path: file.path, sha256: file.sha256, bytes: file.bytes }],
  };
}
