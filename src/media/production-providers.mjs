import { createProductionDirectProvider } from "./production-direct.mjs";
import { createProductionKalturaProvider } from "./production-kaltura.mjs";
import { createProductionYoutubeProvider } from "./production-youtube.mjs";

export function createProductionProviders(context) {
  return Object.freeze({
    kaltura: {
      browser: true,
      create: (page) => createProductionKalturaProvider(page, context),
    },
    direct: {
      browser: true,
      create: (page) => createProductionDirectProvider(page, context),
    },
    youtube: {
      browser: false,
      create: () => createProductionYoutubeProvider(context),
    },
  });
}
