import { chmod, mkdir } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright";
import { COURSES_URL, isIdentityProviderUrl, SIGNED_IN_URL_PATTERN } from "./urls.mjs";

const XSRF_HEADER = "x-blackboard-xsrf";
const SIGN_IN_AGAIN = "Run: npm run login";
// Blackboard's own session cookie does not survive a browser exit — only the load balancer's does —
// so every run arrives logged out and is signed back in by the identity provider on the way to the
// first page. That round trip is seconds on a healthy connection rather than milliseconds, and the
// budget for it is asymmetric: waiting too long costs a slow run, and giving up too early costs a
// session that was never expired being blamed for it, and a person running `login` to no effect.
const SIGN_IN_REDIRECT_TIMEOUT_MS = 60_000;
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
    if (!signedIn) throw new Error(signInStalled(page.url()));

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

// Where it stopped, rather than why it might have. Asserting an expired session for every sign-in
// that has not arrived is what sends a reader to `npm run login` for a slow network, which spends
// an SSO round trip to change nothing and leaves them where they were.
function signInStalled(url) {
  const seconds = SIGN_IN_REDIRECT_TIMEOUT_MS / 1000;
  if (isIdentityProviderUrl(url)) {
    return `NTULearn sign-in is still at the identity provider after ${seconds}s: ${url}. ${SIGN_IN_AGAIN}`;
  }
  return `NTULearn did not answer within ${seconds}s; sign-in stopped at ${url}. Run the command again, and if it keeps happening: ${SIGN_IN_AGAIN}`;
}

async function launchChrome(profilePath, { headless }) {
  validateProfilePath(profilePath);
  await mkdir(profilePath, { recursive: true });
  await chmod(profilePath, 0o700);
  return chromium.launchPersistentContext(profilePath, {
    channel: "chrome",
    headless,
    viewport: headless ? HEADLESS_VIEWPORT : null,
  });
}

function validateProfilePath(profilePath) {
  if (typeof profilePath !== "string" || !isAbsolute(profilePath)) {
    throw new Error("NTULearn profile path must be an absolute filesystem path.");
  }
  if (/%[0-9a-f]{2}/i.test(profilePath)) {
    throw new Error(
      "NTULearn profile path is URL-encoded; pass fileURLToPath(new URL(...)), not URL.pathname.",
    );
  }
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
