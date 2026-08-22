import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createDirectProvider } from "./direct.mjs";
import { abortableProviderWork, throwIfProviderAborted } from "./production-browser.mjs";
import { probeMediaDuration, remuxDirect } from "./production-remux.mjs";
import { directSourceFor, mediaExtension } from "./production-values.mjs";

export function createProductionDirectProvider(page, context) {
  const retained = new Set();
  return createDirectProvider({
    resolveMedia: async ({ appearance, signal }) => {
      const resolved = await resolveDirect(page, appearance, signal, context);
      if (resolved.local) retained.add(resolved.path);
      return resolved.value;
    },
    download: async (path) => ({ path, retained: retained.has(path) }),
    remux: (downloaded, options) => remuxDirect(downloaded, options, context),
  });
}

async function resolveDirect(page, appearance, signal, context) {
  throwIfProviderAborted(signal);
  const source = directSourceFor(appearance);
  if (source.local) {
    return {
      local: true,
      path: source.path,
      value: directMedia(source, await probeMediaDuration(source.path, signal, context)),
    };
  }
  const response = await abortableProviderWork(
    page.context().request.get(source.address, { timeout: 45_000 }),
    signal,
  );
  if (!response.ok()) {
    throw new Error(
      `Direct media request failed: HTTP ${response.status()}. Run: npm run media:discover -- ${appearance.courseKey}`,
    );
  }
  const contentType = response.headers()["content-type"] ?? "";
  if (!/^(?:video|audio)\//i.test(contentType)) {
    throw new Error(
      `Direct media returned ${contentType || "an unknown content type"}. Run: npm run media:discover -- ${appearance.courseKey}`,
    );
  }
  const directory = await mkdtemp(join(context.paths.work, "direct-"));
  const extension = mediaExtension({ url: response.url(), kind: source.kind, contentType });
  const input = join(directory, `source${extension}`);
  try {
    await writeFile(input, await abortableProviderWork(response.body(), signal));
    return {
      local: false,
      path: input,
      value: directMedia(source, await probeMediaDuration(input, signal, context), input),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

function directMedia(source, duration, path = source.path) {
  const representation = { url: path, audio: true, kind: source.kind };
  return {
    kind: source.kind,
    duration,
    media:
      source.kind === "audio"
        ? { audio: [representation] }
        : { video: [{ ...representation, height: 720 }] },
  };
}
