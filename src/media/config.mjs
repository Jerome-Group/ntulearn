import { fileURLToPath } from "node:url";
import {
  assertFilename,
  assertMediaRoot,
  DEFAULT_MEDIA_FREE_SPACE_RESERVE_BYTES,
  MEDIA_MODES,
} from "./paths.mjs";
import { resolve } from "node:path";

const DEFAULT_FILENAMES = {
  mediaTool: "ffmpeg",
  asrRuntime: "whisper-cli",
  asrModel: "ggml-small.en.bin",
  formatterRuntime: "llama-cli",
  formatterModel: "Qwen3-1.7B-Q4_K_M.gguf",
};
const DEFAULT_TOOLS = Object.freeze({ ffprobe: "ffprobe", ytDlp: "yt-dlp" });

export function readMediaMode(value, courseKey) {
  const mode = value ?? "off";
  if (!MEDIA_MODES.includes(mode)) {
    throw new Error(`${courseKey}.mediaMode must be active, pilot, or off.`);
  }
  return mode;
}

export function readMediaConfig(raw, root, courses) {
  const enabled = courses.some((course) => course.mediaMode !== "off");
  if (raw == null) {
    if (enabled) {
      throw new Error(
        "media is required when a course has mediaMode active or pilot. Set media.mediaRoot on RAID0.",
      );
    }
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("media in config/courses.json must be an object.");
  }

  const mediaRoot = assertMediaRoot(raw.mediaRoot);
  const freeSpaceReserveBytes = readReserve(raw.freeSpaceReserveBytes);
  const tools = readTools(raw.tools, root);
  const setup = raw.setup == null ? null : readSetup(raw.setup, root);
  if (enabled && !setup) {
    throw new Error("media.setup is required when a course has mediaMode active or pilot.");
  }

  return { mediaRoot, freeSpaceReserveBytes, tools, setup };
}

function readTools(raw, root) {
  if (raw == null) return { ...DEFAULT_TOOLS };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      "media.tools in config/courses.json must be an object. Copy its shape from config/courses.example.json.",
    );
  }
  return {
    ffprobe: readCommand(raw.ffprobe ?? DEFAULT_TOOLS.ffprobe, "media.tools.ffprobe", root),
    ytDlp: readCommand(raw.ytDlp ?? DEFAULT_TOOLS.ytDlp, "media.tools.ytDlp", root),
  };
}

function readCommand(value, label, root) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a command name or path. Set it in config/courses.json.`);
  }
  const command = value;
  if (command.includes("/") || command.includes("\\")) return resolve(root, command);
  return command;
}

function readReserve(value) {
  const reserve = value ?? DEFAULT_MEDIA_FREE_SPACE_RESERVE_BYTES;
  if (!Number.isSafeInteger(reserve) || reserve <= 0) {
    throw new Error("media.freeSpaceReserveBytes must be a positive safe integer.");
  }
  return reserve;
}

function readSetup(raw, root) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("media.setup in config/courses.json must be an object.");
  }
  return {
    mediaTool: readArtifact(raw.mediaTool, "media.setup.mediaTool", "runtime", root),
    asr: {
      runtime: readArtifact(raw.asr?.runtime, "media.setup.asr.runtime", "runtime", root),
      model: readArtifact(raw.asr?.model, "media.setup.asr.model", "model", root),
    },
    formatter: {
      runtime: readArtifact(
        raw.formatter?.runtime,
        "media.setup.formatter.runtime",
        "runtime",
        root,
      ),
      model: readArtifact(raw.formatter?.model, "media.setup.formatter.model", "model", root),
    },
  };
}

function readArtifact(raw, label, kind, root) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${label} must be an object.`);
  }
  const name = requiredString(raw.name, `${label}.name`);
  const source = readSource(raw.source, `${label}.source`, root);
  const revision = requiredString(raw.revision, `${label}.revision`);
  const sha256 = requiredString(raw.sha256, `${label}.sha256`).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error(`${label}.sha256 must be a 64-character hexadecimal digest.`);
  }
  const license = requiredString(raw.license, `${label}.license`);
  const filename = assertFilename(
    raw.filename ?? DEFAULT_FILENAMES[artifactKey(label)],
    `${label}`,
  );
  const verifyArgs = raw.verifyArgs ?? ["--version"];
  if (!Array.isArray(verifyArgs) || verifyArgs.some((argument) => typeof argument !== "string")) {
    throw new Error(`${label}.verifyArgs must be an array of strings.`);
  }
  return { kind, name, source, revision, sha256, license, filename, verifyArgs };
}

function readSource(value, label, root) {
  const source = requiredString(value, label);
  if (/^https?:\/\//i.test(source)) return { kind: "url", value: source };
  if (/^file:/i.test(source)) return { kind: "file", value: fileURLToPath(new URL(source)) };
  return { kind: "file", value: resolve(root, source) };
}

function artifactKey(label) {
  if (label.endsWith("mediaTool")) return "mediaTool";
  if (label.endsWith("asr.runtime")) return "asrRuntime";
  if (label.endsWith("asr.model")) return "asrModel";
  if (label.endsWith("formatter.runtime")) return "formatterRuntime";
  return "formatterModel";
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${label} must be a non-empty string.`);
  return value;
}
