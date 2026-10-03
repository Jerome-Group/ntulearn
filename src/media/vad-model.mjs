export const VAD_RUNTIME = Object.freeze({
  revision: "whisper.cpp-1.9.2-homebrew-wrapper-1",
  bytes: 188,
  sha256: "f3aeb2821b159923f5b2066ea80e1395c9676b9c4d98c323a5732f955dd7c1d7",
});
export const VAD_DELEGATE = Object.freeze({
  key: "asr.delegate",
  executionPath: "/opt/homebrew/bin/whisper-cli",
  canonicalPath: "/opt/homebrew/Cellar/whisper.cpp/1.9.2/bin/whisper-cli",
  sha256: "40bca494d49af736058eb3f33cbcebaa020eacf6d0087b623f334946e1ab2128",
  bytes: 658608,
  packageVersion: "1.9.2",
});

export function vadDelegateRuntimePin(delegate = VAD_DELEGATE) {
  return {
    key: delegate.key,
    sha256: delegate.sha256,
    bytes: delegate.bytes,
    packageVersion: delegate.packageVersion,
    versionEvidence: "installed-package-declaration",
    sourceBuildVerification: "unrun",
    environmentIdentity: "unclaimed",
  };
}

export const VAD_MODEL = Object.freeze({
  key: "asr.vad",
  revision: "9ffd54a1e1ee413ddf265af9913beaf518d1639b",
  filename: "ggml-silero-v6.2.0.bin",
  sha256: "2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987",
  bytes: 885098,
  license: "MIT",
  source:
    "https://huggingface.co/ggml-org/whisper-vad/resolve/9ffd54a1e1ee413ddf265af9913beaf518d1639b/ggml-silero-v6.2.0.bin",
});
export const VAD_CONTROLS = Object.freeze([
  "--vad-threshold",
  "0.5",
  "--vad-min-speech-duration-ms",
  "250",
  "--vad-min-silence-duration-ms",
  "100",
  "--vad-max-speech-duration-s",
  "3.4028234663852886e+38",
  "--vad-speech-pad-ms",
  "30",
  "--vad-samples-overlap",
  "0.1",
  "--processors",
  "1",
]);

export function vadRuntimePin(model = VAD_MODEL) {
  return {
    key: model.key,
    sha256: model.sha256,
    revision: model.revision,
    bytes: model.bytes,
    controls: [...VAD_CONTROLS],
  };
}

export function validVadRuntimePins(pins) {
  if (
    !Array.isArray(pins) ||
    pins.some((pin) => typeof pin?.key !== "string" || !/^[0-9a-f]{64}$/.test(pin.sha256 ?? "")) ||
    new Set(pins.map((pin) => pin.key)).size !== pins.length
  )
    return false;
  return (
    JSON.stringify(pins.find((pin) => pin.key === VAD_MODEL.key)) ===
      JSON.stringify(vadRuntimePin()) &&
    JSON.stringify(pins.find((pin) => pin.key === VAD_DELEGATE.key)) ===
      JSON.stringify(vadDelegateRuntimePin()) &&
    pins.find((pin) => pin.key === "asr.runtime")?.sha256 === VAD_RUNTIME.sha256 &&
    Boolean(pins.find((pin) => pin.key === "asr.model"))
  );
}
