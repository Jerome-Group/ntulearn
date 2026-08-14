// The attempt count is carried in the evidence contract now; timeout/retry verdicts that interpret
// it belong to issue #85.
export function watchdogVerdict({ sync, verify, preChecks = {}, attempts: _attempts = 1 }) {
  sync ??= {};
  verify ??= {};
  preChecks ??= {};

  if (preChecks.lockHeld) {
    return { verdict: "yellow", message: "skipped: a run was already going" };
  }

  if ([sync, verify].some(sessionLapsed)) {
    return { verdict: "red", message: "session lapsed — run `npm run login`" };
  }

  const failures = (sync.report?.courses ?? []).flatMap((course) => course.failures ?? []);
  const missing = (verify.report?.courses ?? []).flatMap((course) => course.missing ?? []);
  const syncFailed = sync.exitCode !== 0 || !sync.report || failures.length;
  const verifyFailed =
    verify.exitCode !== 0 || !verify.report || verify.report.complete !== true || missing.length;
  if (syncFailed || verifyFailed) {
    const messages = [];
    if (syncFailed) messages.push(syncFailureMessage(failures));
    if (verifyFailed) messages.push(verifyFailureMessage(missing));
    return {
      verdict: "red",
      message: messages.join("; "),
    };
  }

  const newFiles = (sync.report?.courses ?? []).reduce(
    (total, course) => total + (course.downloaded ?? 0) + (course.markdownWritten ?? 0),
    0,
  );

  return { verdict: "green", message: `synced, ${newFiles} new files` };
}

function sessionLapsed(command) {
  const failures = (command?.report?.courses ?? []).flatMap((course) => course.failures ?? []);
  const evidence = [
    command?.stderr,
    command?.error,
    command?.message,
    ...failures.map((failure) => failure.error),
  ]
    .filter(Boolean)
    .join("\n");
  return /the saved session is no longer signed in|not signed in while downloading|http 401/i.test(
    evidence,
  );
}

function syncFailureMessage(failures) {
  const first = failures[0];
  return `sync failed: ${failures.length} failures; first failure: ${first?.file ?? "no file"} (trail: ${first?.trail || "(root)"}); run npm run watchdog`;
}

function verifyFailureMessage(missing) {
  return `verify failed: ${missing.length} missing files; first path: ${missing[0]?.path ?? "unknown"}; run npm run watchdog`;
}
