import { isGlobalMediaSafetyFailure } from "./errors.mjs";
import { captureKalturaResponses } from "./kaltura-responses.mjs";
import { createKalturaProvider } from "./kaltura.mjs";
import { abortableProviderWork, throwIfProviderAborted } from "./production-browser.mjs";
import { remuxKaltura } from "./production-remux.mjs";
import { mediaManifestUrl, mediaTime } from "./production-values.mjs";

export function createProductionKalturaProvider(page, context) {
  return createKalturaProvider({
    resolveEntry: ({ reference, signal }) => resolveKaltura(page, reference, signal),
    download: async (url) => ({ url }),
    remux: (downloaded, options) => remuxKaltura(downloaded, options, context),
  });
}

async function resolveKaltura(page, reference, signal) {
  throwIfProviderAborted(signal);
  const entryId = entryIdOf(reference);
  const address =
    "https://api.sg.kaltura.com/p/117/sp/11700/embedIframeJs" +
    `/uiconf_id/23448394/partner_id/117?iframeembed=true&playerId=kaltura_player&entry_id=${encodeURIComponent(entryId)}`;
  const capture = captureKalturaResponses({ signal });
  page.on("response", capture.observe);
  try {
    await abortableProviderWork(
      page.goto(address, { waitUntil: "domcontentloaded", timeout: 45_000 }),
      signal,
    );
    await abortableProviderWork(
      page.waitForLoadState("networkidle", { timeout: 15_000 }),
      signal,
    ).catch((error) => {
      if (isGlobalMediaSafetyFailure(error)) throw error;
      throwIfProviderAborted(signal);
    });
    const play = page.locator('button[aria-label*="Play"],button[aria-label*="play"]').first();
    if ((await abortableProviderWork(play.count(), signal)) > 0) {
      await abortableProviderWork(play.click({ timeout: 10_000 }), signal).catch((error) => {
        if (isGlobalMediaSafetyFailure(error)) throw error;
        throwIfProviderAborted(signal);
      });
    }
    for (let attempt = 0; attempt < 60 && !mediaManifestUrl(capture.manifests); attempt += 1) {
      capture.assert();
      await abortableProviderWork(page.waitForTimeout(100), signal);
    }
    capture.assert();
    const manifest = mediaManifestUrl(capture.manifests);
    if (!manifest) {
      throw new Error(
        "Kaltura playback manifest was not exposed. Check signed-in playback, then retry the media worker.",
      );
    }
    const duration = await kalturaDuration(page, signal);
    page.off("response", capture.observe);
    const captured = await capture.finish();
    return {
      duration,
      ...(captured.limitations.length ? { limitations: captured.limitations } : {}),
      media: { video: [{ url: manifest, height: 720, audio: true }] },
      ...(captured.captions[0]
        ? {
            transcript: {
              body: captured.captions[0],
              language: "und",
              filename: "captions.vtt",
              captionProvenance: { kind: "observed", language: "und", format: "vtt" },
            },
          }
        : {}),
    };
  } catch (error) {
    if (isGlobalMediaSafetyFailure(error)) throw error;
    capture.assert();
    throw error;
  } finally {
    page.off("response", capture.observe);
    capture.dispose();
  }
}

async function kalturaDuration(page, signal) {
  const body = await abortableProviderWork(page.locator("body").innerText(), signal).catch(
    (error) => {
      if (isGlobalMediaSafetyFailure(error)) throw error;
      throwIfProviderAborted(signal);
      return "";
    },
  );
  const match = [
    ...body.matchAll(/(\d{1,2}:\d{2}(?::\d{2})?)\s*\/\s*(\d{1,2}:\d{2}(?::\d{2})?)/g),
  ].at(-1);
  const displayed = match ? mediaTime(match[2]) : null;
  const duration = Number.isFinite(displayed)
    ? displayed
    : await abortableProviderWork(
        page
          .locator("video")
          .evaluate((video) => (Number.isFinite(video.duration) ? video.duration : null)),
        signal,
      ).catch((error) => {
        if (isGlobalMediaSafetyFailure(error)) throw error;
        throwIfProviderAborted(signal);
        return null;
      });
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(
      "Kaltura playback duration was not exposed. Check signed-in playback, then retry the media worker.",
    );
  }
  return duration;
}

function entryIdOf(reference) {
  const text = String(reference ?? "");
  if (text.startsWith("entry:")) return text.slice("entry:".length);
  const match = text.match(/\/media\/t\/([^/]+)/);
  if (match) return match[1];
  throw new Error(
    "Unsupported Kaltura reference shape. Run media discovery again before retrying the worker.",
  );
}
