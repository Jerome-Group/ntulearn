import { chmod, mkdir } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright";
import { COURSES_URL, SIGNED_IN_URL_PATTERN } from "./urls.mjs";

const XSRF_HEADER = "x-blackboard-xsrf";
const SIGN_IN_AGAIN = "Run: npm run login";
const SIGN_IN_REDIRECT_TIMEOUT_MS = 15_000;
const TOKEN_TIMEOUT_MS = 10_000;
const TOKEN_POLL_MS = 250;
const HEADLESS_VIEWPORT = { width: 1280, height: 900 };

export async function openLoginWindow(profilePath) {
  const context = await launchChrome(profilePath, { headless: false });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(COURSES_URL, { waitUntil: "domcontentloaded" });
  return { page, close: () => context.close() };
}

export async function openSignedInContext(profilePath) {
  const context = await launchChrome(profilePath, { headless: true });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    const capturedToken = captureXsrfToken(page);

    await page.goto(COURSES_URL, { waitUntil: "domcontentloaded" });
    const signedIn = await page
      .waitForURL(SIGNED_IN_URL_PATTERN, { timeout: SIGN_IN_REDIRECT_TIMEOUT_MS })
      .then(
        () => true,
        () => false,
      );
    if (!signedIn) throw new Error(`NTULearn session expired. ${SIGN_IN_AGAIN}`);

    let token = await waitForToken(capturedToken);
    if (!token) {
      await page.reload({ waitUntil: "domcontentloaded" });
      token = await waitForToken(capturedToken);
    }
    if (!token) throw new Error(`Could not capture the NTULearn session token. ${SIGN_IN_AGAIN}`);

    return { context, token };
  } catch (error) {
    await context.close();
    throw error;
  }
}

async function launchChrome(profilePath, { headless }) {
  await mkdir(profilePath, { recursive: true });
  await chmod(profilePath, 0o700);
  return chromium.launchPersistentContext(profilePath, {
    channel: "chrome",
    headless,
    viewport: headless ? HEADLESS_VIEWPORT : null,
  });
}

// The token is never served to us; it rides on the requests the page makes once it has one.
function captureXsrfToken(page) {
  let token = "";
  page.on("request", (request) => {
    token ||= request.headers()[XSRF_HEADER] ?? "";
  });
  return () => token;
}

async function waitForToken(capturedToken) {
  const deadline = Date.now() + TOKEN_TIMEOUT_MS;
  while (!capturedToken() && Date.now() < deadline) await sleep(TOKEN_POLL_MS);
  return capturedToken();
}
