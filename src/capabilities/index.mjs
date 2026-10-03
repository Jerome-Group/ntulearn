import { WORKER_STOP_CODES, WORKER_STOP_STAGES } from "../media/worker-stop.mjs";
import { VAD_MODEL, VAD_CONTROLS, VAD_RUNTIME, VAD_DELEGATE } from "../media/vad-model.mjs";
import { RECOVERY_POLICY, RECOVERY_POLICIES } from "../media/recovery-policy.mjs";

const livePrerequisites = ["configured-courses", "Owner-approval", "saved-student-session"];
const mediaPrerequisites = ["configured-media", "RAID0", "free-space-reserve", "prepared-runtime"];

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
  renumber: [["src/sync/renumber.mjs"], ["test/renumber.test.mjs"]],
  watchdog: [
    ["src/watchdog/run.mjs", "src/watchdog/verdict.mjs"],
    ["test/watchdog-run.test.mjs", "test/watchdog.test.mjs"],
  ],
  "media-discovery": [
    [
      "src/cli.mjs",
      "src/media/discover-run.mjs",
      "src/ntulearn/session.mjs",
      "src/media/safety.mjs",
      "src/media/lock.mjs",
      "src/media/discovery.mjs",
      "src/media/queue.mjs",
      "src/media/classification.mjs",
      "src/media/session-path.mjs",
      "src/media/external.mjs",
      "src/media/disposition.mjs",
      "src/media/gallery.mjs",
      "src/media/gallery-browser.mjs",
      "src/media/gallery-launch.mjs",
      "src/media/gallery-diagnostic.mjs",
      "src/media/course-announcement.mjs",
      "src/media/workflow.mjs",
    ],
    [
      "test/cli.test.mjs",
      "test/media-discover-run.test.mjs",
      "test/media-discover-cli.test.mjs",
      "test/media-lock.test.mjs",
      "test/media-discovery.test.mjs",
      "test/media-queue.test.mjs",
      "test/media-classification.test.mjs",
      "test/media-session-path.test.mjs",
      "test/media-external.test.mjs",
      "test/media-disposition.test.mjs",
      "test/media-gallery.test.mjs",
      "test/media-gallery-browser.test.mjs",
      "test/media-gallery-launch.test.mjs",
      "test/media-gallery-diagnostic.test.mjs",
      "test/media-course-announcement.test.mjs",
      "test/media-gallery-read-guard.test.mjs",
      "test/media-workflow.test.mjs",
    ],
  ],
  "media-acquisition": [
    [
      "src/media/acquisition.mjs",
      "src/media/production-providers.mjs",
      "src/media/capture.mjs",
      "src/media/captions.mjs",
      "src/media/production-youtube.mjs",
      "src/media/production-kaltura.mjs",
      "src/media/production-remux.mjs",
      "src/media/kaltura-responses.mjs",
    ],
    [
      "test/media-production.test.mjs",
      "test/media-capture.test.mjs",
      "test/media-captions.test.mjs",
      "test/media-caption-ingestion.test.mjs",
      "test/kaltura.test.mjs",
      "test/kaltura-responses.test.mjs",
      "test/media-production-kaltura.test.mjs",
      "test/media-production-remux.test.mjs",
      "test/youtube.test.mjs",
      "test/direct.test.mjs",
    ],
  ],
  transcripts: [
    [
      "src/media/job.mjs",
      "src/media/artifacts.mjs",
      "src/media/native-transcript-safety.mjs",
      "src/media/asr.mjs",
      "src/media/transcript.mjs",
      "src/media/caption-text.mjs",
      "src/media/formatter.mjs",
      "src/media/formatter-output.mjs",
      "src/media/production-local.mjs",
      "src/media/source-paragraphs.mjs",
    ],
    [
      "test/media-job.test.mjs",
      "test/media-artifacts.test.mjs",
      "test/media-native-transcript-safety.test.mjs",
      "test/media-asr.test.mjs",
      "test/media-transcript.test.mjs",
      "test/media-caption-text.test.mjs",
      "test/media-formatter.test.mjs",
      "test/media-formatter-output.test.mjs",
      "test/media-production-local.test.mjs",
      "test/media-source-paragraphs.test.mjs",
      "test/media-source-review.test.mjs",
      "test/media-source-production.test.mjs",
    ],
  ],
  "transcript-catalogue": [
    [
      "src/media/catalogue.mjs",
      "src/media/catalogue-files.mjs",
      "src/media/catalogue-media.mjs",
      "src/media/catalogue-media-read.mjs",
      "src/media/catalogue-safety.mjs",
      "src/media/catalogue-profile.mjs",
      "src/media/catalogue-inventory.mjs",
      "src/media/catalogue-course.mjs",
      "src/media/catalogue-editions.mjs",
      "src/media/vad-model.mjs",
      "src/media/catalogue-publication.mjs",
      "src/media/recovery-manifest.mjs",
      "src/media/recovery-files.mjs",
    ],
    [
      "test/media-catalogue.test.mjs",
      "test/media-catalogue-media.test.mjs",
      "test/media-catalogue-recovery.test.mjs",
      "test/media-catalogue-editions.test.mjs",
      "test/media-catalogue-publication.test.mjs",
      "test/media-catalogue-cli.test.mjs",
      "test/media-catalogue-files.test.mjs",
      "test/media-recovery-files.test.mjs",
    ],
  ],
  "historical-transcripts": [
    [
      "src/media/historical.mjs",
      "src/media/historical-format.mjs",
      "src/media/historical-files.mjs",
      "src/media/historical-inventory.mjs",
      "src/cli.mjs",
    ],
    [
      "test/media-historical.test.mjs",
      "test/media-historical-format.test.mjs",
      "test/media-historical-files.test.mjs",
      "test/media-historical-inventory.test.mjs",
      "test/cli.test.mjs",
    ],
  ],
  "media-evaluation": [
    [
      "src/media/evaluation.mjs",
      "src/media/evaluation-manifest.mjs",
      "src/media/evaluation-alignment.mjs",
      "src/media/evaluation-process.mjs",
      "src/media/evaluation-fixture.mjs",
      "src/media/evaluation-read.mjs",
      "src/media/evaluation-storage.mjs",
    ],
    [
      "test/media-evaluation.test.mjs",
      "test/media-evaluation-manifest.test.mjs",
      "test/media-evaluation-alignment.test.mjs",
      "test/media-evaluation-process.test.mjs",
      "test/media-evaluation-fixture.test.mjs",
      "test/media-evaluation-read.test.mjs",
      "test/media-evaluation-storage.test.mjs",
      "test/media-production-local.test.mjs",
      "test/cli.test.mjs",
    ],
  ],
  "media-storage": [
    [
      "src/cli.mjs",
      "src/media/lock.mjs",
      "src/media/storage.mjs",
      "src/media/status.mjs",
      "src/media/queue.mjs",
      "src/media/queue-course.mjs",
      "src/media/completeness.mjs",
    ],
    [
      "test/media-storage.test.mjs",
      "test/media-status.test.mjs",
      "test/media-queue.test.mjs",
      "test/media-queue-course.test.mjs",
      "test/cli.test.mjs",
      "test/media-lock.test.mjs",
    ],
  ],
  "media-worker": [
    [
      "src/media/worker.mjs",
      "src/media/worker-report.mjs",
      "src/media/worker-stop.mjs",
      "src/media/production.mjs",
      "src/ntulearn/client.mjs",
      "src/ntulearn/session.mjs",
      "src/cli.mjs",
      "src/media/lock.mjs",
      "src/media/process.mjs",
      "src/media/digest.mjs",
      "src/media/safety.mjs",
      "src/media/errors.mjs",
      "src/media/queue.mjs",
      "src/media/worker-state.mjs",
      "src/media/transcript-evidence.mjs",
      "src/media/capacity.mjs",
      "src/media/capacity-monitor.mjs",
      "src/media/capacity-deadline.mjs",
    ],
    [
      "test/media-worker.test.mjs",
      "test/media-worker-stop.test.mjs",
      "test/media-transcript-evidence.test.mjs",
      "test/media-production.test.mjs",
      "test/media-signal-ownership.test.mjs",
      "test/session.test.mjs",
      "test/media-safety.test.mjs",
      "test/media-errors.test.mjs",
      "test/media-queue.test.mjs",
      "test/media-lock.test.mjs",
      "test/media-process.test.mjs",
      "test/media-process-boundary.test.mjs",
      "test/media-capacity.test.mjs",
      "test/media-capacity-monitor.test.mjs",
      "test/media-capacity-deadline.test.mjs",
    ],
  ],
  "media-runtime": [
    [
      "src/media/setup.mjs",
      "src/media/vad-setup.mjs",
      "src/media/vad.mjs",
      "src/media/vad-model.mjs",
      "src/media/config.mjs",
      "src/media/paths.mjs",
      "src/media/runtime-command.mjs",
      "src/media/runtime-verification.mjs",
    ],
    [
      "test/media-setup.test.mjs",
      "test/media-vad.test.mjs",
      "test/media-runtime-command.test.mjs",
      "test/media-runtime-verification.test.mjs",
      "test/media-production.test.mjs",
      "test/config.test.mjs",
    ],
  ],
  "media-recovery": [
    ["src/media/retry.mjs", "src/media/safety.mjs", "src/media/queue.mjs", "src/cli.mjs"],
    ["test/media-retry.test.mjs", "test/media-safety.test.mjs", "test/cli.test.mjs"],
  ],
  "transcript-source-recovery": [
    [
      "src/media/recovery.mjs",
      "src/media/recovery-files.mjs",
      "src/media/recovery-policy.mjs",
      "src/media/vad.mjs",
      "src/media/vad-setup.mjs",
      "src/media/vad-model.mjs",
      "src/media/recovery-manifest.mjs",
      "src/media/recovery-authority.mjs",
      "src/media/recovery-candidate.mjs",
      "src/media/recovery-publication.mjs",
      "src/media/production-local.mjs",
      "src/cli.mjs",
    ],
    [
      "test/media-recovery.test.mjs",
      "test/media-recovery-manifest.test.mjs",
      "test/media-recovery-incomplete.test.mjs",
      "test/media-recovery-candidate.test.mjs",
      "test/media-recovery-policy.test.mjs",
      "test/media-vad.test.mjs",
      "test/media-runtime-command.test.mjs",
      "test/media-recovery-files.test.mjs",
      "test/media-recovery-publication.test.mjs",
      "test/cli.test.mjs",
    ],
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
          "Exclusive identity attachment placements and rendered-digest announcement revisions; originals and edits retained",
        receiptCounts: ["newEditions", "reusedFiles", "unresolvedIdentity", "publicationConflicts"],
        limits: {
          provenanceRecordsPerIdentity: 128,
          provenanceRecordBytes: 65536,
          suffixedFilenameBytes: 160,
        },
        verification:
          "Shared positive placement metadata, then presence only; State is not consulted",
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
        "Presence relative to the content walk; no byte fidelity or exhaustive upstream/media completeness claim.",
      ],
    },
  ),
  command(
    "renumber",
    "renumber",
    "renumber",
    [...livePrerequisites, "Drive-mounted", "Owner-rename-decision"],
    { ...live, writes: ["proven-unmodified-course-paths"] },
    { arguments: courseArgument, risk: "rename" },
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
    "media-setup",
    "media:setup",
    "media-runtime",
    ["configured-media", "RAID0", "free-space-reserve", "Owner-setup-approval"],
    {
      network: true,
      reads: ["pinned-artifact-sources"],
      writes: ["media-runtime"],
      ownerOnly: true,
    },
    {
      risk: "runtime-install",
      arguments: ["[vad]"],
      optionalVad: {
        policy: "independent-context-nonspeech-vad-v1",
        model: VAD_MODEL,
        runtime: VAD_RUNTIME,
        delegate: VAD_DELEGATE,
        controls: VAD_CONTROLS,
        prerequisites: ["prepared-base-runtime", "media-queue-lock", "safe-media-admission"],
        receipt: "separate-immutable-companion",
        baseManifestWrites: false,
        output: "capability-result-v1",
        exitCodes: offlineCodes,
        repeat: "Repeat npm run media:setup -- vad unchanged; foreign occupied evidence refuses.",
        limits:
          "Only explicit Owner setup downloads the pinned optional model. Matching repeats skip. Neither setup nor policy proves acoustic fidelity; VAD can omit speech. Logical download deadline does not guarantee physical network settlement.",
      },
    },
  ),
  command(
    "media-discover",
    "media:discover",
    "media-discovery",
    [...livePrerequisites, "media-queue-lock", "safe-media-admission"],
    { ...live, writes: ["media-queues", "course-media-status", "cleanup-safety-barrier"] },
    {
      arguments: courseArgument,
      risk: "live-session",
      courseContexts:
        "Sequential canonical context per enabled course; positive closure before queue/status publication or another context. Sticky Gallery guard never resets.",
      exitCodes: { passed: 0, incompleteOrInterrupted: 1, runtimeRefused: 1, usage: 2 },
      report:
        "Private discovery report with completed/refused/notAttempted courses, fixed failure/cleanup/barrier codes; existing course evidence remains private.",
      limitations: [
        "Owned discovery handles SIGINT/SIGTERM; abort immediately starts available context close and requires positive close plus read settlement. Canonical startup cannot be physically cancelled before a client returns. Unknown cleanup stops the batch and retains a durable admission barrier before queue-lock release. A close deadline is not physical cancellation; Owner containment is required on uncertainty. Disabled courses skip browser reads. Ordinary sync/verify/renumber retain shared-session semantics.",
        "Gallery initializes and confirms its sticky owned-context NTULearn GET/HEAD guard before the single canonical metadata snapshot and navigation, including absent/unknown dialogs. A uniquely course/content-bound supplied unsigned launchPlacement link with mandatory matching placement.id may open directly; malformed/ambiguous/conflicting/signed links refuse without legacy fallback. Only absent launch metadata uses the course surface, and refuses further operations after guard failure. Guard evidence is rechecked after owned page closure; uncertain cleanup globally stops admission. It may close only one exact New Course Announcement with dedicated Close. Known service workers, unknown/auth/consent/multiple dialogs and unconfirmed guard/close refuse; no force or Mark as read. Read requests use fallback to preserve existing route chaining; no request URLs/headers/payloads retained. No completeness claim for media acquisition/transcript quality or arbitrary contexts/service workers.",
      ],
    },
  ),
  command(
    "media-worker",
    "media:worker",
    "media-worker",
    [...livePrerequisites, ...mediaPrerequisites, "media-queue-lock", "durable-media-queues"],
    {
      ...live,
      writes: ["media-store", "course-media-artifacts", "media-queues", "private-media-logs"],
    },
    {
      arguments: ["[scheduled|manual]", "[priority-course (manual only)]"],
      risk: "media-acquisition",
      limitations: [
        "Scheduled mode works only 00:00–03:59 Asia/Singapore; manual mode ignores the overnight boundary.",
        "Manual priority reorders all enabled courses; media owns browser SIGINT/SIGTERM so checkpoint, browser cleanup, queue-lock release and final digest can settle. Login/nonmedia browser defaults remain unchanged; cleanup failure still blocks readiness.",
      ],
    },
  ),
  command(
    "media-catalogue",
    "media:catalogue",
    "transcript-catalogue",
    ["configured-courses", "accessible-course-roots", "retained-edition-provenance"],
    {
      reads: ["private-queue-and-transcript-evidence", "positively-owned-local-retained-media"],
      writes: [
        "fresh-plan-for-plan",
        "managed-course-index-and-immutable-history-for-publish",
        "exceptional-safety-barrier-on-unconfirmed-file-cleanup",
      ],
      ownerOnly: false,
    },
    {
      arguments: [
        "inspect | plan <private-manifest> [private-selection-file] | publish <private-manifest> PUBLISH_TRANSCRIPT_CATALOGUE | verify <private-manifest>",
      ],
      risk: "local-user-storage",
      output: "operation-specific",
      exitCodes: offlineCodes,
      operations: {
        inspect: {
          network: false,
          browser: false,
          runtime: false,
          ownerOnly: false,
          writes: [],
          output: "private-catalogue-metadata-v1",
          exceptionalWrites: ["safety-barrier-on-unconfirmed-file-cleanup"],
          prerequisites: ["accessible-course-roots"],
        },
        plan: {
          network: false,
          browser: false,
          runtime: false,
          ownerOnly: false,
          writes: ["fresh-exclusive-private-plan"],
          output: "capability-result-v1",
          prerequisites: ["fresh-private-manifest-path", "optional-private-digest-selection"],
          exceptionalWrites: ["safety-barrier-on-unconfirmed-file-cleanup"],
        },
        publish: {
          network: false,
          browser: false,
          runtime: false,
          ownerOnly: true,
          writes: [
            "managed-course-index",
            "producer-journal",
            "immutable-index-history-and-beforeimages",
          ],
          output: "capability-result-v1",
          prerequisites: [
            "unchanged-private-catalogue-plan",
            "PUBLISH_TRANSCRIPT_CATALOGUE",
            "RAID0-and-reserve",
            "media-queue-lock",
            "positive-managed-index-ownership-or-pinned-absence",
          ],
        },
        verify: {
          network: false,
          browser: false,
          runtime: false,
          ownerOnly: false,
          writes: [],
          output: "capability-result-v1",
          prerequisites: ["unchanged-private-catalogue-plan"],
          exceptionalWrites: ["safety-barrier-on-unconfirmed-file-cleanup"],
        },
      },
      limitations: [
        "All configured local queue appearances accounted for as recognized recordings, unresolved review or positively classified non-recordings; retained source evidence accounted for; upstream completeness and acoustic verification unrun. Inspect emits private bounded titles/IDs/local links; no transcript/config/profile/log bodies. Plan/publication/verify emit bounded counts/codes only.",
        "Retained media access independently requires unique current recording/course placement plus queue/checkpoint and metadata-if-present ownership. Historical, review and incomplete reading verdicts may link one positively owned local file; access never clears source review or proves acquisition/completeness/acoustics. Foreign, missing, withdrawn, ambiguous or unsafe paths stay unproven; typed storage/read failures fail closed. Configured root aliases are supported; runtime/profile paths excluded before media content reads.",
        "New retained-access media streams use separate counters:32GiB per file,128GiB aggregate,4096 hashes,100000 descriptor identity checks,30s per media I/O operation and120s operation deadline, without raising the metadata256MiB/120s budget or relaxing existing recovery verifiers. Regular no-follow descriptor SHA/device/inode/size/mtime/ctime and parent pins checked at admission/final and before writes. Timeout/abort allows5s for positive pending-I/O/descriptor-close settlement; unknown cleanup emitsMEDIA_FILE_CLEANUP and persists an admission barrier before lock release (exceptional safety write in every mode). Failed barrier storage requires external containment. Access may link owned video while immutable recovery provenance names separately owned audio; both stay pinned. No universal filesystem CAS or physical I/O cancellation claim.",
        "Prefer a unique eligible recovered digest, otherwise unique eligible current-source paragraph digest. Equivalent digests group; distinct candidates require explicit recordingId/sha256 selections. Source flags exclude paragraph preference; unknown recovery timing refuses. Canonical source review/media verdicts remain unchanged.",
        "Generation candidate proofs stay immutable; current per-recording ownership is independently revalidated without generation-time whole-queue SHA. Publication plans pin the entire current inventory and refuse subsequent input changes. Existing managed index requires positive producer hash/history; user edits refuse. Retry identical plan after journalled interruption; no automatic sync publication or universal external-edit CAS guarantee.",
        "Catalogue metadata scans every decoded key/value, including overwritten duplicate-key tokens: 16MiB input, 100000 values, depth16, 1MiB per string plus unchanged native address guards. Proposed plans remain capped at4MiB and validate both plan and receipt before any write. Per-operation read budget256MiB/120s remains; private plan/receipt get full hashes at admission/final and descriptor-bound identity checks between writes. Bounded failures retain evidence and emit fixed codes; no native transcript gate is relaxed.",
      ],
    },
  ),
  command(
    "media-format",
    "media:format",
    "historical-transcripts",
    ["configured-courses", "private-manifest-path", "accessible-course-roots"],
    {
      reads: ["private-transcripts", "private-provenance", "media-queues"],
      writes: ["private-plan-for-plan", "exclusive-transcript-editions-and-indexes-for-apply"],
      ownerOnly: false,
    },
    {
      arguments: ["<plan|apply|verify>", "<private-manifest-path>"],
      risk: "local-user-storage",
      output: "capability-result-v1",
      exitCodes: offlineCodes,
      operations: {
        plan: {
          network: false,
          browser: false,
          writes: ["fresh-private-plan"],
          runtime: false,
          ownerOnly: false,
          prerequisites: ["accessible-course-roots", "fresh-private-manifest-path"],
        },
        apply: {
          ownerOnly: true,
          prerequisites: [
            "private-historical-manifest",
            "Owner-apply-authorization",
            "RAID0-and-reserve",
            "media-queue-lock",
          ],
          network: false,
          browser: false,
          writes: [
            "exclusive-editions",
            "private-checkpoint-receipts",
            "course-transcript-indexes",
          ],
          runtime: false,
        },
        verify: {
          network: false,
          browser: false,
          writes: [],
          runtime: false,
          ownerOnly: false,
          prerequisites: ["private-historical-manifest"],
        },
      },
      limitations: [
        "Source words preserved; timing failures and suspected source corruption remain separate. No acoustic or complete/ready media claim. Originals and historical queues/state/status are never replaced.",
      ],
    },
  ),
  command(
    "media-retry",
    "media:retry",
    "media-recovery",
    [
      "configured-courses",
      "accessible-course-roots",
      "current-complete-discovery",
      "safe-media-admission",
    ],
    {
      reads: ["media-queues", "private-media-safety-evidence"],
      writes: ["retry-permission-and-status-for-apply"],
    },
    {
      arguments: ["<plan|apply>", "<course|all>", "<failed|recordingId>", "[RETRY_FAILED_MEDIA]"],
      risk: "local-user-storage",
      output: "capability-result-v1",
      exitCodes: offlineCodes,
      operations: {
        plan: { network: false, browser: false, ownerOnly: false, writes: [], runtime: false },
        apply: {
          network: false,
          browser: false,
          ownerOnly: true,
          writes: ["media-queues", "course-media-status"],
          runtime: false,
          prerequisites: ["Owner-retry-authorization", "literal-confirmation", "media-queue-lock"],
        },
      },
      limitations: [
        "Permission to retry only; no acquisition, transcription or completeness verdict is changed. Failure history and existing artifacts remain. Cleanup safety barriers and markers cannot be cleared.",
      ],
    },
  ),
  command(
    "media-recover",
    "media:recover",
    "transcript-source-recovery",
    [
      "configured-courses",
      "private-source-recovery-manifest",
      "positive-source-media-ownership",
      "safe-media-admission",
    ],
    {
      reads: ["private-source-media-digests", "media-queues", "private-media-safety-evidence"],
      writes: [
        "exclusive-private-candidates-for-run",
        "exclusive-lecture-editions-and-course-indexes-for-publish",
      ],
    },
    {
      manifest: {
        schemaVersion: 1,
        policy: RECOVERY_POLICY,
        supportedPolicies: RECOVERY_POLICIES,
        maximumRecordings: 64,
        authorities: {
          default: "metadata-owned-original",
          "state-owned-unformatted": {
            fields: [
              "authority.kind",
              "authority.state.path",
              "authority.state.sha256",
              "authority.queue.path",
              "authority.queue.sha256",
              "authority.metadata.path",
              "authority.metadata.absent",
              "authority.original.path",
              "authority.original.absent",
            ],
            fallback: false,
            queueReadinessWrites: false,
            limits:
              "Enabled course and uniquely owned raw/state/current queue/media required; metadata and original derivative must be absent with existing canonical parent identities. Hashes/absence rechecked under lock; no atomic compare-and-swap guarantee against every external editor.",
          },
        },
        recordingFields: [
          "courseKey",
          "recordingId",
          "source.path",
          "source.sha256",
          "media.path",
          "media.sha256",
        ],
        maximumBudgets: {
          maxRecordingSeconds: 28800,
          maxInputBytes: 34359738368,
          maxOutputBytes: 34359738368,
          jobTimeoutMs: 86400000,
          processTimeoutMs: 28800000,
        },
        paths:
          "Manifest-relative or absolute canonical physical files; private input paths and identities are not emitted in structured reports.",
      },
      arguments: [
        "<plan|run|publish>",
        "<private-manifest>",
        "[candidate-directory (run/publish only)]",
      ],
      risk: "local-user-storage",
      output: "capability-result-v1",
      exitCodes: offlineCodes,
      operations: {
        plan: { ownerOnly: false, network: false, browser: false, writes: [], runtime: false },
        run: {
          ownerOnly: true,
          network: false,
          browser: false,
          writes: ["fresh-private-candidates", "native-ASR-output", "private-provenance"],
          runtime: true,
          prerequisites: [
            "Owner-recovery-authorization",
            "prepared-runtime",
            "RAID0-and-reserve",
            "media-queue-lock",
            "fresh-output-directory",
          ],
        },
        publish: {
          ownerOnly: true,
          network: false,
          browser: false,
          writes: ["exclusive-lecture-editions", "course-recovery-indexes"],
          runtime: false,
          optionalVadRuntime:
            "Verified prepared asset and bounded ASR help probe for VAD policy only",
          prerequisites: [
            "Owner-publication-authorization",
            "unchanged-private-candidates",
            "eligible-only-subset-unflagged-native-and-timing-evidence",
            "RAID0-and-reserve",
            "media-queue-lock",
          ],
        },
      },
      limitations: [
        "Fresh ASR candidates retain every original and queue history. No canonical source replacement, automatic retry or acoustic/completeness claim. Explicit independent-context policies optionally suppress decoder nonspeech tokens during full-input generation; no post-generation filtering or quality claim. The optional VAD policy requires explicit Owner media:setup vad, trusted wrapper and delegated-executable SHA/bytes/canonical resolution/help capabilities and companion receipt before output/ASR; package version is declared metadata, source/build and dynamic-library identity unproven; fixed controls and model pin are retained. VAD predicts spans and can omit speech; full-recording coverage still applies. Recovery never installs assets. Native malformed/dropped segments, suspicious repetition and failed timing block that candidate. Explicit publish writes only the validated eligible subset and reports remaining review as blocked; edited evidence fails the whole publication. Partial durable output counts and unchanged repeat route remain in structured failure evidence.",
      ],
    },
  ),
  command(
    "media-evaluate",
    "media:evaluate",
    "media-evaluation",
    [
      "private-evaluation-manifest",
      "authorized-source-audio",
      "prepared-runtime-for-run",
      "RAID0-and-reserve-for-run",
    ],
    {
      reads: ["private-manifest", "private-audio", "private-reference", "runtime-for-run"],
      writes: ["fresh-private-evaluation-directory-for-run"],
    },
    {
      arguments: ["<plan|run>", "<manifest>", "[fresh-output-directory]"],
      risk: "local-media-resources",
      output: "capability-result-v1",
      exitCodes: offlineCodes,
      operations: {
        plan: { network: false, browser: false, writes: [], runtime: false },
        run: {
          network: false,
          browser: false,
          writes: ["fresh-private-evaluation-directory"],
          runtime: true,
        },
      },
      limitations: [
        "Declared script alignment does not prove acoustic fidelity. Annotation quality requires independent review.",
      ],
    },
  ),
  command(
    "media-withdraw",
    "media:withdraw",
    "media-storage",
    [
      "configured-courses",
      "durable-media-queue",
      "media-queue-lock",
      "Owner-withdrawal-confirmation",
    ],
    { reads: ["media-queue"], writes: ["media-queue", "course-media-status"], ownerOnly: true },
    {
      arguments: ["<course>", "<recordingId>", "confirm"],
      risk: "withdrawal",
      limitations: ["Stops unfinished work; keeps acquired artifacts."],
    },
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
    { reads: ["configuration", "filesystem-metadata", "runtime-manifest"] },
    { kind: "health", output: "capability-result-v1", exitCodes: offlineCodes },
  ),
  command(
    "status",
    "status",
    "capabilities",
    ["local-configuration"],
    { reads: ["configuration", "local-queues", "sync-receipts", "local-digests"] },
    { kind: "status", output: "capability-result-v1", exitCodes: offlineCodes },
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
      "private-catalogue-metadata-v1": {
        fields: ["schemaVersion", "command", "status", "exitCode", "catalogue"],
        privacy:
          "Private bounded course/recording IDs, titles, source flags and local/provenance links; never transcript bodies, raw configuration, signed URLs, profile contents or raw exceptions. Inspect stdout is a private metadata report.",
        exitCodes: offlineCodes,
      },
      "capability-result-v1": {
        fields: ["schemaVersion", "command", "status", "exitCode", "checks", "evidence"],
        statuses: ["passed", "failed", "blocked", "unrun"],
        checks: ["id", "status", "code", "message", "action", "evidence"],
        exitCodes: offlineCodes,
        privacy:
          "Bounded structured evidence; no raw private configuration, transcript or log contents.",
      },
    },
    commands: selected,
    features: selectedFeatures.map(([id, [code, tests]]) => ({
      id,
      code,
      ...(id === "transcripts"
        ? {
            formatting: {
              version: "source-paragraphs-v1",
              modelCalls: 0,
              reviewRequired: { complete: false, retryable: false, queueOnlyClear: false },
              limitations:
                "Source-preserving paragraphs and lexical flags do not establish acoustic accuracy; flagged sources require explicit Owner review or source-preserving recovery.",
            },
          }
        : {}),
      ...(id === "media-worker"
        ? {
            stopEvidence: {
              field: "stopFailures",
              fields: ["code", "stage"],
              codes: WORKER_STOP_CODES,
              stages: WORKER_STOP_STAGES,
              unknown:
                "UNKNOWN code or unknown stage records unavailable current evidence; never infer a cause from historical limitations.",
              scope:
                "Only actual stopped course summaries; admission/preflight/runner-settlement are run-only. Final run log and digest retain observed triggers.",
              privacy:
                "New evidence has no raw exceptions, paths, identifiers or addresses; existing worker reports remain private.",
              safety:
                "Reporting grants no release, retry, marker clearing, source-review override or live qualification.",
            },
          }
        : {}),
      verification: { command: "npm run check", tests },
      actions: commands
        .filter(
          (entry) =>
            entry.kind === "action" &&
            (entry.feature === id ||
              (["transcripts", "media-acquisition", "media-storage"].includes(id) &&
                entry.id === "media-worker")),
        )
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
      "Offline health/status describe observed local evidence; they never prove upstream or media completeness.",
      "ESM JavaScript has no static type checker; syntax, lint, runtime contracts and fixtures are the applicable checks.",
      "Owner-only actions require specific approval. No command installs media tools except media:setup.",
    ],
  };
}
