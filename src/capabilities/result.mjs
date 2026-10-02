export function capabilityResult(command, checks, evidence = {}) {
  const status = checks.some((check) => check.status === "failed")
    ? "failed"
    : checks.some((check) => check.status === "blocked")
      ? "blocked"
      : checks.every((check) => check.status === "unrun")
        ? "unrun"
        : "passed";
  return {
    schemaVersion: 1,
    command,
    status,
    exitCode: status === "failed" ? 1 : status === "passed" ? 0 : 2,
    checks,
    evidence,
  };
}

export function observation(id, status, code, message, action = null, evidence = {}) {
  return { id, status, code, message, action, evidence };
}
