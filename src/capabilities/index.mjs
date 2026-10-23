const livePrerequisites = ["configured-courses", "Owner-approval", "saved-student-session"];

const routes = {
  authentication: [
    ["src/ntulearn/session.mjs", "src/ntulearn/client.mjs", "src/ntulearn/sign-in.mjs"],
    ["test/session.test.mjs", "test/read.test.mjs", "test/sign-in.test.mjs"],
  ],
  discovery: [
    [
      "src/ntulearn/content.mjs",
      "src/ntulearn/read.mjs",
      "src/ntulearn/reader.mjs",
      "src/ntulearn/collections.mjs",
      "src/courses.mjs",
    ],
    [
      "test/content.test.mjs",
      "test/read.test.mjs",
      "test/reader.test.mjs",
      "test/collections.test.mjs",
      "test/courses.test.mjs",
    ],
  ],
  sync: [
    [
      "src/sync/course.mjs",
      "src/config.mjs",
      "src/sync/expected.mjs",
      "src/sync/files.mjs",
      "src/sync/state.mjs",
      "src/sync/source-editions.mjs",
      "src/sync/source-provenance.mjs",
      "src/sync/markdown.mjs",
      "src/ntulearn/download.mjs",
    ],
    [
      "test/course.test.mjs",
      "test/config.test.mjs",
      "test/expected.test.mjs",
      "test/files.test.mjs",
      "test/state.test.mjs",
      "test/source-editions.test.mjs",
      "test/source-provenance.test.mjs",
      "test/markdown.test.mjs",
      "test/download.test.mjs",
    ],
  ],
  verification: [
    [
      "src/sync/verify.mjs",
      "src/sync/import-status.mjs",
      "src/sync/source-editions.mjs",
      "src/sync/source-provenance.mjs",
    ],
    [
      "test/verify.test.mjs",
      "test/import-status.test.mjs",
      "test/source-editions.test.mjs",
      "test/source-provenance.test.mjs",
    ],
  ],
  renumber: [
    ["src/sync/renumber.mjs", "src/sync/renumber-files.mjs"],
    ["test/renumber.test.mjs", "test/renumber-files.test.mjs", "test/cli.test.mjs"],
  ],
  watchdog: [
    ["src/watchdog/run.mjs", "src/watchdog/verdict.mjs"],
    ["test/watchdog-run.test.mjs", "test/watchdog.test.mjs"],
  ],
  library: [
    [
      "src/library/catalogue.mjs",
      "src/library/search.mjs",
      "src/library/html.mjs",
      "src/config.mjs",
    ],
    ["test/library.test.mjs", "test/library-cli.test.mjs"],
  ],
  capabilities: [
    [
      "src/capabilities/index.mjs",
      "src/capabilities/check.mjs",
      "src/capabilities/check-capture.mjs",
      "src/capabilities/check-evidence.mjs",
      "src/capabilities/health.mjs",
      "src/capabilities/status.mjs",
    ],
    [
      "test/capabilities.test.mjs",
      "test/capability-check.test.mjs",
      "test/capability-check-capture.test.mjs",
      "test/capability-check-evidence.test.mjs",
      "test/capability-check-cli.test.mjs",
      "test/capability-health.test.mjs",
      "test/capability-status.test.mjs",
      "test/capability-contracts.test.mjs",
      "test/capability-result.test.mjs",
      "test/capability-read.test.mjs",
      "test/cli.test.mjs",
    ],
  ],
};

function command(id, script, feature, prerequisites, effects, options = {}) {
  return {
    id,
    script,
    invocation: `npm run ${script}`,
    machineInvocation: `npm run --silent ${script}`,
    kind: options.kind ?? "action",
    arguments: options.arguments ?? [],
    prerequisites,
    effects: {
      network: false,
      browser: false,
      reads: [],
      writes: [],
      ownerOnly: false,
      ...effects,
    },
    risk: options.risk ?? "low",
    output: options.output ?? "existing-cli-report",
    exitCodes: options.exitCodes ?? { 0: "success", 1: "failure" },
    feature,
    code: routes[feature][0],
    verification: {
      command: "npm run check",
      tests: routes[feature][1],
      requiresNetwork: false,
      requiresBrowser: false,
    },
    ...options,
  };
}

const live = {
  network: true,
  browser: true,
  reads: ["configuration", "student-session", "NTULearn"],
  ownerOnly: true,
};
const courseArgument = ["<course|all>"];
const offlineCodes = { 0: "passed", 1: "failed", 2: "blocked-or-unrun-or-usage" };
const CHECK_EVIDENCE = {
  flag: "--evidence",
  default: false,
  namespace: ".scratch/check-evidence-<safe-name>",
  prerequisites: ["fresh-unoccupied-repo-owned-directory", "canonical-no-follow-parents"],
  permissions: { directory: "0700", files: "0600" },
  reference: "requested-private-evidence/<check>-<ordinal>",
  files: [
    "<check>-<ordinal>.stdout.log",
    "<check>-<ordinal>.stderr.log",
    "<check>-<ordinal>.invocation.json",
    "run.start.json",
    "run.result.json",
  ],
  bounds: {
    streamPrefixBytes: 2097152,
    invocationBytes: 65536,
    receiptBytes: 131072,
    files: 17,
    totalBytes: 22020096,
    operationMs: 5000,
    cumulativeIoMs: 30000,
    settlementMs: 5000,
  },
  privacy:
    "Only fixed anonymous references/files/digests/counts/exit codes leave private storage. Raw output, arguments, paths and exceptions stay private. Prefix truncation has separate bytes/digest from original captured output.",
  failure:
    "Original check failure unchanged; evidence refusal or unconfirmed cleanup is a separate blocked/failed observation. Retain partial files, no overwrite/prune/upload. Unconfirmed cleanup stops further checks and all evidence writes.",
};
const commands = [
  command(
    "login",
    "login",
    "authentication",
    ["configured-profile", "Owner-login"],
    { ...live, writes: ["student-session"] },
    { risk: "session" },
  ),
  command("discover", "discover", "discovery", livePrerequisites, live, { risk: "live-session" }),
  command(
    "sync",
    "sync",
    "sync",
    [...livePrerequisites, "distinct-course-destinations", "Drive-mounted"],
    { ...live, writes: ["course-destinations", "sync-state", "sync-receipts"] },
    {
      arguments: courseArgument,
      risk: "user-storage",
      sourceEditions: {
        provenanceDirectory: "Source editions",
        identity: "SHA-256 of positive upstream identity; ambiguous/missing identities refuse",
        publication:
          "Exclusive identity attachment placements, fetched-digest attachment revisions, and rendered-digest page and announcement revisions; originals and edits retained",
        receiptCounts: ["newEditions", "reusedFiles", "unresolvedIdentity", "publicationConflicts"],
        limits: {
          provenanceRecordsPerIdentity: 128,
          provenanceRecordBytes: 65536,
          suffixedFilenameBytes: 160,
        },
        verification:
          "Shared positive current-revision placement metadata, then presence only; legacy unassociated attachments are missing until sync; State is not consulted",
      },
    },
  ),
  command(
    "verify",
    "verify",
    "verification",
    [...livePrerequisites, "Drive-mounted"],
    { ...live, reads: [...live.reads, "course-destinations"] },
    {
      arguments: courseArgument,
      risk: "live-session",
      limitations: [
        "Presence relative to the content walk; no byte fidelity or exhaustive upstream completeness claim.",
      ],
    },
  ),
  command(
    "renumber",
    "renumber",
    "renumber",
    [...livePrerequisites, "Drive-mounted", "Owner-rename-decision"],
    { ...live, writes: ["course-file-names", "private-renumber-claims"] },
    {
      arguments: courseArgument,
      risk: "rename",
      exitCodes: {
        0: "completed-or-ordinary-kept-files",
        1: "failure-blocked-moves-or-recovery-claims",
      },
      renumberProtocol: {
        publication:
          "Claim into private 0700 sibling after complete intent, prove captured regular inode, exclusive hard link; never unlink or overwrite public endpoints",
        recovery:
          "Retain every failed capture, even after exclusive restoration; read-only discovery gates new work; Owner verifies recovery before removing claims",
        folders: "Refused; portable Node cannot exclusively publish a directory rename",
        limits: {
          discoveryEntries: 10000,
          directoryDepth: 64,
          claimsInspected: 128,
          manifestBytes: 4096,
        },
      },
      limitations: [
        "Proof observes one captured inode; later writes through open descriptors or hard links follow that inode and are not frozen.",
        "Requires no-follow and nonblocking inspection plus same-filesystem hard links. Process interruption covered; hostile ancestor replacement, filesystem corruption and power-loss durability unproved.",
      ],
    },
  ),
  command(
    "watchdog",
    "watchdog",
    "watchdog",
    [...livePrerequisites, "Drive-mounted", "watchdog-lock"],
    {
      ...live,
      writes: ["course-destinations", "sync-state", "sync-receipts", "private-watchdog-logs"],
    },
    { risk: "user-storage" },
  ),
  command(
    "capabilities",
    "capabilities",
    "capabilities",
    [],
    {},
    {
      kind: "index",
      arguments: ["[command-id|feature]"],
      output: "capability-index-v1",
      exitCodes: offlineCodes,
    },
  ),
  command(
    "health",
    "health",
    "capabilities",
    ["local-configuration"],
    {
      reads: ["configuration", "filesystem-metadata"],
    },
    { kind: "health", output: "capability-result-v1", exitCodes: offlineCodes },
  ),
  command(
    "status",
    "status",
    "capabilities",
    ["local-configuration"],
    {
      reads: ["configuration", "sync-receipts", "local-digests"],
    },
    { kind: "status", output: "capability-result-v1", exitCodes: offlineCodes },
  ),
  command(
    "library",
    "library",
    "library",
    ["local-configuration", "distinct-course-destinations", "runtime-outside-destinations"],
    {
      reads: [
        "configuration",
        "course-Markdown",
        "attachment-filenames",
        "sync-receipts",
        "filesystem-metadata",
      ],
    },
    {
      kind: "read",
      arguments: ["[--course <key>]", "[--query <text>]", "[--html]"],
      output: "local-library-v1-or-self-contained-html",
      exitCodes: {
        0: "complete-local-scan",
        1: "partial-or-unavailable-local-scan",
        2: "usage-config-or-platform-refusal",
      },
      limitations: [
        "Private stdout contains local course text snippets, names, and file locations. Keep HTML exports outside course destinations.",
        "Literal case-insensitive substring search over Markdown and filenames. Attachments are never opened.",
        "Receipts are independent of scan success. No upstream completeness or current source revision claim.",
        "Bounded no-follow local observation detects observed changes; portable Node cannot exclude hostile concurrent ancestor swaps.",
      ],
    },
  ),
  command(
    "check",
    "check",
    "capabilities",
    ["supported-Node", "npm-ci-ignore-scripts"],
    {
      reads: ["repository", "installed-dependencies"],
      writes: ["isolated-test-temporary-files", "explicit-fresh-private-check-evidence"],
    },
    {
      kind: "test",
      arguments: [
        "[all|syntax|contracts|format|lint|test]",
        "[--evidence .scratch/check-evidence-<safe-name>]",
      ],
      risk: "local-private-evidence-if-requested",
      optionalEvidence: CHECK_EVIDENCE,
      output: "capability-result-v1",
      exitCodes: offlineCodes,
    },
  ),
  ...["syntax", "contracts"].map((name) =>
    command(
      `check:${name}`,
      `check:${name}`,
      "capabilities",
      ["supported-Node"],
      { reads: ["repository"], writes: ["explicit-fresh-private-check-evidence"] },
      {
        kind: "test",
        arguments: ["[--evidence .scratch/check-evidence-<safe-name>]"],
        risk: "local-private-evidence-if-requested",
        optionalEvidence: CHECK_EVIDENCE,
        output: "capability-result-v1",
        exitCodes: offlineCodes,
        limitations: [
          "Same optional private evidence contract as check; default behavior unchanged.",
        ],
      },
    ),
  ),
  ...["test", "lint", "format:check"].map((name) =>
    command(
      name,
      name,
      "capabilities",
      ["supported-Node", "npm-ci-ignore-scripts"],
      {
        reads: ["repository", "installed-dependencies"],
        writes: name === "test" ? ["isolated-test-temporary-files"] : [],
      },
      { kind: "test", output: "tool-native" },
    ),
  ),
  command(
    "format",
    "format",
    "capabilities",
    ["npm-ci-ignore-scripts"],
    { reads: ["repository"], writes: ["repository-code"] },
    { risk: "code-write", output: "tool-native" },
  ),
];

export function capabilityIndex(selection) {
  const selected = selection
    ? commands.filter((entry) => entry.id === selection || entry.feature === selection)
    : commands;
  const selectedFeatures = Object.entries(routes).filter(
    ([id]) => !selection || id === selection || selected.some((entry) => entry.feature === id),
  );
  if (!selected.length && !selectedFeatures.length)
    throw new Error("Unknown capability. Run: npm run capabilities");
  return {
    schemaVersion: 1,
    configuration: {
      defaultFile: "config/courses.json",
      exampleFile: "config/courses.example.json",
      overrideEnvironmentVariable: "NTULEARN_CONFIG_PATH",
      pathResolution:
        "Absolute or checkout-relative configuration; relative values resolve from the checkout root.",
      privacy:
        "Real course identifiers and storage paths belong in private configuration; never copy session profile contents.",
    },
    outputContracts: {
      "local-library-v1-or-self-contained-html": {
        fields: [
          "schemaVersion",
          "command",
          "status",
          "exitCode",
          "observedAt",
          "query",
          "courses",
          "materialCount",
          "matchCount",
          "materials",
          "limits",
          "diagnostics",
          "evidence",
        ],
        statuses: ["complete", "partial", "blocked"],
        courseEvidence: [
          "scan",
          "receipt",
          "counts",
          "exclusions",
          "diagnostics",
          "suppressedDiagnostics",
        ],
        html: "Same selected courses' bounded catalogue, editable query, native course filter, plain-text reader, generated local file links, strict CSP; no server or network.",
      },
      "capability-result-v1": {
        fields: ["schemaVersion", "command", "status", "exitCode", "checks", "evidence"],
        statuses: ["passed", "failed", "blocked", "unrun"],
        checks: ["id", "status", "code", "message", "action", "evidence"],
        exitCodes: offlineCodes,
        privacy: "Bounded structured evidence; no raw private configuration or log contents.",
      },
    },
    commands: selected,
    features: selectedFeatures.map(([id, [code, tests]]) => ({
      id,
      code,
      verification: { command: "npm run check", tests },
      actions: commands
        .filter((entry) => entry.kind === "action" && entry.feature === id)
        .map((entry) => entry.invocation),
    })),
    internalCommands: [
      {
        id: "watchdog-locked",
        public: false,
        parent: "watchdog",
        prerequisites: ["watchdog-lock-held"],
        effects: commands.find((entry) => entry.id === "watchdog").effects,
      },
    ],
    limitations: [
      "Offline health/status describe observed local evidence; they never prove upstream completeness.",
      "ESM JavaScript has no static type checker; syntax, lint, runtime contracts and fixtures are the applicable checks.",
      "Owner-only actions require specific approval.",
    ],
  };
}
