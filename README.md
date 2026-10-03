# NTULearn Sync

Signs in to NTULearn once and keeps a copy of your courses on disk: pages and announcements as
Markdown, attachments as the files they already are. Authentication and sync state stay in this
repository; course files go to whichever folder you point each course at.

MIT licensed and public — `docs/adr/0002`.

## Status

In use. Course pages, announcements and attachments sync today, and the command line and the
shape of `config/courses.json` are settled — a change to either would be a breaking change rather
than a Tuesday. The local media runtime, Kaltura/YouTube/direct content-tree tracers, and
fixture-driven Kaltura Media Gallery discovery, controlled browser-playback fallback, and
one-at-a-time queue worker are explicit and Owner-started. Durable media completeness is reported
separately from sync and verify.

## Commands

Start with `npm run capabilities`: its versioned JSON index lists prerequisites, Owner restrictions,
read/write effects, arguments, implementation and fixture verification routes. It needs no local
configuration or browser installation. Select a command or feature with
`npm run capabilities -- transcripts`.

```bash
npm run health               # offline config/filesystem observations; never opens the session
npm run status               # offline receipts, queues and digest freshness; no source contents
npm run check                # shared CI/agent syntax, contracts, format, lint and fixture checks
npm run check -- test        # one check; unselected checks explicitly unrun
```

These three commands emit `schemaVersion: 1`, per-check `passed`, `failed`, `blocked` or `unrun`,
actions and bounded evidence. Exit codes: `0` passed, `1` failed, `2` blocked/unrun/usage. Health
reads only profile directory metadata; it does not validate login. Runtime metadata observations
do not replace the worker's checksum/tool/reserve verifier. Status counts queue declarations,
keeps sync/media verdicts separate and treats evidence older than 48 hours as stale; it does not
prove artifact bytes, audio fidelity or exhaustive upstream visibility. Private course paths,
identifiers, raw errors and log contents are excluded.

`npm ci --ignore-scripts`, then `npm run check` is the clean-checkout verification route. It runs
the existing `npm test`, `npm run lint` and `npm run format:check` tools plus ESM syntax and catalog
contracts, without browser/network tests. Each check is bounded to two minutes and all selected
checks report even after another fails. Evidence includes elapsed time, exit code and output hash;
failed tool details can be read locally by running the indexed tool command. No TypeScript is
present: syntax, lint, runtime contracts and fixture/process regressions are the applicable checks.

```bash
npm run login                 # refresh the NTU SSO/MFA session
npm run discover              # list the NTULearn courses you can see
npm run watchdog              # run sync and verify under the daily-run watchdog
npm run sync -- MH2100        # sync one configured course
npm run sync -- all           # sync every configured course
npm run verify -- all         # check what is on disk against NTULearn, writing nothing
npm run renumber -- MH2500    # rename what is on disk back into the course's order today
npm run media:setup            # Owner-started: prepare and verify the local media runtime
npm run media:discover -- all  # Owner-started: discover and queue recording appearances
npm run media:worker -- manual # Owner-started: process every enabled queue now
npm run media:worker            # Scheduled semantics: work only from 00:00 through 03:59
npm run media:withdraw -- MH1101 media-gallery:_9_1:gallery-entry confirm  # confirm one withdrawal
```

`media:setup` is the only command that prepares media dependencies or models. Sync, verify,
watchdog and future scheduled media runs never install anything. A successful media discovery
writes its per-course queue under `.data/media-queue/`; a red discovery writes no jobs.

The production entrypoint is `npm run media:worker -- <scheduled|manual>`. One invocation covers
every enabled course and provider in its aggregate digest. Unsupported appearances become terminal
red failures. A red, queued, checkpointed, locked, or otherwise incomplete aggregate exits
non-zero. `scheduled` is the default and runs only from 00:00 through
03:59 local time, checkpoints the active appearance at 04:00, and writes the independent
`.data/media-latest.json` digest plus `.data/media-logs/`. `mode: "manual"` ignores that time
boundary. Queue entries are `queued`, `active`, `checkpointed`, `complete`, or `red`; successful
entries are skipped on later runs, while failures remain retryable. Runs share
`.data/media-queue.lock`, so a manual run cannot overlap a scheduled one. The worker never calls
`media:setup`. Every enabled course has `Media Gallery/media-status.md`, and every discovered
appearance has a sibling `.media-status.md` with provider, source, stage, video/audio availability,
transcript provenance, retryability, and limitations. A queued appearance is yellow until its next
eligible worker window; an attempted incomplete source or derivative is red and remains retryable.
The status documents and queue remain independent from sync and verify verdicts.

## Configuration

Copy the example and edit it. `config/courses.json` is ignored by Git — it holds your own
destination paths, and it is meant to stay on your machine.

```bash
cp config/courses.example.json config/courses.json
```

```json
{
  "profilePath": ".data/chrome-profile",
  "statePath": ".data/state.json",
  "driveMountPath": "/absolute/path/to/Google Drive",
  "watchdogTimeoutMs": 900000,
  "media": {
    "mediaRoot": "/Volumes/RAID0/Media",
    "freeSpaceReserveBytes": 107374182400,
    "tools": {
      "ffprobe": "ffprobe",
      "ytDlp": "yt-dlp"
    }
  },
  "courses": [
    {
      "key": "AB1234",
      "courseId": "_0000000_1",
      "destination": "/absolute/path/to/Google Drive/My Drive/Modules/Y1S1/AB1234/NTULearn",
      "mediaMode": "off"
    }
  ]
}
```

| Field | Required | What it is |
|-------|----------|------------|
| `courses[].key` | yes | What you type at `npm run sync -- <key>`. Matched case-insensitively, and must be unique across the file under that same matching. The course code is the obvious choice. |
| `courses[].courseId` | yes | NTULearn's own identifier for the course, of the form `_1234567_1`. Run `npm run discover` to list the ones you can see. |
| `courses[].destination` | yes | Where the files land. Absolute, or relative to the repository root. No two courses may share one, or nest one inside another, including physical aliases. A standalone root alias is allowed. |
| `profilePath` | no | The saved browser session. Defaults to `.data/chrome-profile`. |
| `statePath` | no | What has already been downloaded. Defaults to `.data/state.json`. |
| `driveMountPath` | no (watchdog yes) | The Google Drive mount that contains the destinations. Before writing, the watchdog requires both this directory and each destination's first Drive root below it to be present. |
| `watchdogTimeoutMs` | no | The watchdog's initial timeout in milliseconds. The Owner pins the placeholder `900000` from the first week's logged durations. |
| `media.mediaRoot` | required for `active`/`pilot` | The explicit Media store. It must be a directory below `/Volumes/RAID0`; there is no system-disk fallback. |
| `media.freeSpaceReserveBytes` | no | Free space retained on the Media store before setup or acquisition. Defaults to 100 GiB. |
| `media.tools.ffprobe` | no | Portable command name or explicit path for `ffprobe`; defaults to `ffprobe` on `PATH`. Worker preflight verifies it can execute. |
| `media.tools.ytDlp` | no | Portable command name or explicit path for `yt-dlp`; defaults to `yt-dlp` on `PATH`. Worker preflight verifies it can execute. |
| `courses[].mediaMode` | no | Exactly `active`, `pilot`, or `off`; omitted means `off` for legacy configurations. No semester is inferred. |

### Preparing the media runtime

An `active` or `pilot` course also requires `media.setup`. It names five pinned artifacts:
`mediaTool` (FFmpeg), `asr.runtime` and `asr.model` (whisper.cpp), and `formatter.runtime` and
`formatter.model` (llama.cpp plus the selected local formatter model). Each artifact records a
`name`, destination `filename`, local file or HTTPS `source`, `revision`, SHA-256 `sha256`, and
`license`; runtime artifacts may also set `verifyArgs`, defaulting to `--version`.

The Owner runs `npm run media:setup` after filling those entries. It checks that RAID0 is mounted,
the Media store is a real directory, the reserve is available, and existing runtime paths are not
symlinks before creating `Media/.runtime/{bin,models,cache,tmp,work,metadata}`. It copies or
downloads the pinned artifacts, verifies their checksums and runtime commands, and writes only
`Media/.runtime/metadata/runtime.json`. The manifest records identity, revision, checksum,
licence, path and size. Every worker run refuses a missing, replaced or misconfigured runtime or
tool and points back to `media:setup`; model weights, caches and working files remain outside this
repository. Cheap canonical-path and free-space checks run before each acquisition and every
second while a job is active; they do not rehash models. Artifact writes account for the incoming
bytes on their destination filesystem and recheck the reserve before promotion. Capacity failures
cancel acquisition, preserve previously held artifacts and stop the queue red with a retry action.
Each cheap check has a five-second logical deadline, including the final monitor drain. An
underlying read-only filesystem probe may remain pending; its late result cannot authorize a write.
Physical writes and copies remain awaited: stalled I/O can delay completion, and no later job starts
while it is pending.

Mandatory worker verification keeps all five full checksums, manifest identities, canonical roots,
reserve checks and external-tool checks. Read-only verification has a 120-second cumulative logical
budget; pending OS reads may continue after failure, but cannot advance to acquisition. Each tool
has a 30-second execution bound plus the existing owned-group cleanup bound and 1 MiB per-output
limit. The CLI setup and worker supply owned-group cleanup; direct library calls without that
composition stop only the leader and do not confirm descendant cleanup. Setup copies, downloads
and promotions remain awaited: these read deadlines do not claim cancellation of setup writes.

The selected runtime and model licences are documented in
`docs/research/media-runtime.md`. Setup is intentionally not run by CI or by an ordinary sync.

### Content-tree recording tracers

An `active` or `pilot` course may have recording appearances alongside its ordinary sync. Recording
completeness is a separate concern: the sync remains additive and does not claim that media work is
complete. Each appearance keeps its own placement and status, while source evidence and working
artifacts stay on the configured Media store and readable derivatives stay beside the numbered item.
Kaltura, YouTube, and direct video/audio links are classified without retaining expiring query strings;
opaque embedded or launch references remain visibly unresolved rather than silently omitted. Known
FeedbackFruits, Cengage, Blackboard placement, Padlet, and Turnitin shapes keep their provider name,
stable reference, retryability, and limitation in the status; provider-specific acquisition is an
injected adapter seam. Nested file/media metadata is inspected to depth four and at most 64
values. Positive document MIME types or filename/address extensions identify excluded
non-recordings; positive audio/video evidence identifies recordings, including unsupported
recordings whose acquisition reference is unavailable. Conflicting, mixed, cyclic or oversized
metadata remains unresolved. Tool names, upload IDs and earlier failures never prove a resource
is not a recording.

The digest and course status separately count recording failures, unresolved appearances and
excluded non-recordings. Exclusion skips acquisition and never counts as a complete transcript;
unresolved appearances keep the aggregate red without adding acquisition attempts. Inspect an
unresolved resource in NTULearn, then the Owner can re-run `npm run media:discover -- <course>`
when positive metadata or an adapter becomes available. Rediscovery preserves stable appearance
identities, established placements, artifacts and attempt history; disappearance does not delete
an appearance. Fresh document metadata conflicting with retained recording evidence remains
unresolved for review. Legacy rows without sufficient identity proof are retained rather than
being guessed into another artifact owner. Historical unsupported failures therefore cannot all
be dismissed as irrelevant without fresh evidence. Session material and expiring provider addresses are never persisted. A transcript
is complete only when both
a validated source and formatted Markdown derivative exist. Recording completeness remains
independent of sync and follows [ADR-0014](docs/adr/0014-recordings-use-a-separate-media-workflow.md);
source provenance and status remain visible with the course artifacts. The routine job never
replaces a formatted derivative. An agent-led caller must opt into `runMediaJob({ regenerate: true })`;
replacement requires one ownership record matching the recording identity, source digest and current
derivative digest. A path alone is insufficient. Storage checks the derivative again after staging
and capacity checks, immediately before promotion. This catches edits during those steps, but the
check followed by rename is not atomic compare-and-swap and cannot guarantee protection against every
concurrent editor. Historical bulk repair must publish fresh exclusive editions and retain originals.
New write-once artifacts use exclusive hard-link publication; occupied targets are preserved, and a
filesystem without that support fails with a next action rather than an overwrite fallback.

Kaltura response capture bounds application-retained manifest and caption text, rather than claiming
a browser-wide RAM or network limit. Playwright may buffer a response internally before exposing
its text; announced lengths are checked first, but received-byte rejection cannot undo that
buffering. Caption capture failures remain visible while local ASR can supply a source. Pending
browser reads have a logical drain deadline; the production client closes its owned page, without
claiming physical I/O cancellation or universal process cleanup.

The current formatter changes presentation only: punctuation, paragraph breaks and Markdown
emphasis or list markers must preserve ordered source words, spelling, case, numbers, symbols and
code-switching. It leaves recognition errors and spoken mathematics intact rather than inferring
corrections or notation. Unsupported edits fall back to source wording and report the limitation.
These lexical checks do not prove semantic equivalence or acoustic fidelity; changing the prompt
alone does not establish improved model quality.
The pinned formatter CLI mixes its display banner and rendered input into stdout, even when
prompt display is disabled. Formatting therefore requires a separate assistant record with the
exact known input prefix; ambiguous or missing records preserve source wording. This separates
CLI display from candidate acquisition without relaxing transcript checks or proving model quality.

### Controlled browser-playback fallback

Browser playback remains a last resort because it is more intrusive and less reproducible than
provider retrieval. The fallback is limited to controls and media already visible to the signed-in
student, checks for meaningful audio before capture, restores temporary routing on every exit, and
keeps 2x disabled until Owner evidence proves it safe for one provider.

### Offline transcript evaluation

A synthesis script records intended words, not verified acoustic ground truth. Evaluation keeps
conditional reference alignment, timestamp/coverage validation, formatter lexical preservation,
and acoustic review separate. An annotation must declare listening provenance tied to the exact
source and reference SHA-256 hashes; that declaration still cannot prove annotation quality.
Neither model agreement nor a formatter fallback proves speech fidelity or semantic equivalence.

`src/media/evaluation.mjs` exposes read-only `planMediaEvaluation({ manifestPath })` and local
`runMediaEvaluation({ manifestPath, outputDirectory, outputRoot, media, signalProcessGroup,
memoryMeasurement, codeRevision, signal })`. A private version-1 JSON manifest declares:

```json
{
  "version": 1,
  "budgets": {
    "maxFixtureSeconds": 300,
    "maxInputBytes": 268435456,
    "maxOutputBytes": 67108864,
    "jobTimeoutMs": 600000,
    "processTimeoutMs": 120000
  },
  "fixtures": [{
    "audio": { "path": "source.wav", "sha256": "<source SHA-256>" },
    "reference": {
      "kind": "generated-script",
      "path": "reference.txt",
      "sha256": "<reference SHA-256>",
      "provenance": {
        "method": "speech-synthesis",
        "sourceSha256": "<source SHA-256>",
        "referenceSha256": "<reference SHA-256>"
      }
    }
  }]
}
```

Use `annotated-audio` with `listening-annotation` for a declared acoustic annotation, or
`{ "kind": "unavailable" }` when no reference exists. Relative paths resolve beside the
private manifest. Optional `interruptionAfterMs` deliberately checkpoints ASR, then attempts
recovery with a fresh signal. Evaluation does not synthesize references, acquire media, install
assets, or grant access. Keep manifests and results private.

Runs require the configured runtime's full mandatory verification and capacity checks, and a
fresh output directory below the configured Media store. The API's explicit `outputRoot` can
select an already authorized private scratch directory on the same canonical RAID0 device;
the default and CLI boundary remain the Media store. This parameter is not an access grant.
Existing attempts and user edits are never reused. Native ASR output, failed process output and evaluation-owned work are retained privately; invalid
timestamps stay failed and formatting stays unrun. Restore the reported runtime/storage or
correct the manifest, then retry into another fresh directory. Public structured results contain
hashes, safe flags and aggregate measurements, without source words, local paths or raw errors.

Prevalidation and plan reads have a five-second logical deadline and stream aborts. The declared
job budget covers the whole run after manifest validation, including runtime preflight and final
input checks; read probes also respect its remaining time. Writes are never raced against a
logical deadline because a late physical write could promote rejected evidence.

Wall times describe individual subprocesses; extraction, ASR and each formatter invocation are
recorded separately. `memoryMeasurement: "darwin-time"` uses the installed macOS time tool's
maximum resident set size; missing or ambiguous measurement records leave memory `null`/`unrun`.
`wallMsBeforeReport` includes preflight and final input verification, excluding the final report write. Observed peak storage is
sampled and checked at stage boundaries, not a continuous maximum. Logical read-probe and
process deadlines cannot cancel arbitrary physical filesystem I/O or independently detached
process descendants. Acoustic quality remains blocked until independent review supplies stronger
evidence; successful lexical checks and conditional alignment never turn that block green.

### Kaltura Media Gallery discovery

Enabled `pilot` and `active` courses can use the separate Media Gallery workflow. It opens the
signed-in course surface, exhausts its visible `Load More`/pagination controls, and refuses to
queue any appearance until the discovered visible count matches the Gallery's displayed total.
Gallery order is retained; repeated provider entries remain separate appearances, and sanitized
creation-time/title names receive a collision number only when necessary. Kaltura provider media,
provider transcripts, normalized sources, and working artifacts stay under the RAID0 Media store.
Formatted transcripts and per-recording status stay under the course destination's `Media Gallery/`
folder. Courses with `mediaMode: "off"` are never opened. The `media:discover` command emits the
reconciled appearance queue but does not change `sync` or `verify`'s completeness verdict. The
complete queue is the handoff to the existing media-job seam; the queue worker consumes it one
job at a time and supplies the execution context (`course`, `signal`, `mode`, and
`requestCheckpoint`) to the provider-backed runner. The queue artifact is the durable handoff; its
independent worker digest never changes `sync` or `verify`'s completeness verdict.

`media:withdraw` is the explicit confirmation route for one queued appearance. It writes a
withdrawn tombstone into the queue, leaves every existing artifact alone, and never withdraws a
completed appearance.

The media runner owns the original POSIX process group. Supported runtimes keep descendants
in that group. Timeout,
checkpoint and output overflow request `SIGTERM`, allow 250 ms grace, then request `SIGKILL`
if the group remains; forced cleanup confirmation is bounded to a further 1,000 ms. The
checkpoint reason remains the primary error only after that group is confirmed absent. Unconfirmed
cleanup stops the worker globally and preserves scratch files for inspection; its error retains the
exact initiating failure as non-enumerable `originalReason`, separately from the cleanup `cause`.
That diagnostic property does not permit checkpoint recovery after unsafe cleanup. Output capture defaults
to 8 MiB stdout and 256 KiB stderr, with smaller protocol-specific stdout bounds; overflow
fails rather than returning truncated successful output.

Runtime daemonization or descendants creating another session/process group (including
`setsid` or independently detached children) are unsupported. Such descendants can outlive a
successful parent and are outside the original-group evidence: successful cleanup does not
prove exhaustive orphan recovery. Safely supervising those runtimes requires a separate
execution design; broad process scans or unrelated-process kills are not a recovery mechanism.
The [platform boundary](docs/research/detached-process-containment.md) records why ancestry polling
and stock macOS process notifications cannot establish arbitrary-descendant ownership.
The [containment design evaluation](docs/research/platform-containment-design.md) compares macOS27
Endpoint Security and Linux cgroups, with explicit prerequisites and unrun qualification routes.
`node --test test/media-process-boundary.test.mjs` reproduces timeout/checkpoint escapes with closed
and inherited pipes, while checking original-group cancellation and an unrelated sentinel. Its
explicit `independentlyDetached: failed/unsupported` evidence keeps that limitation visible; a
passing boundary test is not a passing universal termination criterion.

## Scheduling the media worker

The checked-in example is `config/com.jerome-group.ntulearn.media-worker.example.plist`. Copy it
to `~/Library/LaunchAgents/`, replace its Node and repository placeholders, set explicit
`media.tools` paths when launchd's `PATH` cannot find them, then bootstrap it. It starts at 00:00;
the worker itself enforces the 04:00 checkpoint. Its process exit is non-zero for every red or
incomplete aggregate, so launchd and the two log paths retain the unsuccessful run signal.

## Scheduling the watchdog

The checked-in example is `config/com.jerome-group.ntulearn.watchdog.example.plist`. Copy it to
`~/Library/LaunchAgents/com.jerome-group.ntulearn.watchdog.plist`, replace every placeholder with
the real Node executable and repository paths, then load it for the logged-in user:

```bash
cp config/com.jerome-group.ntulearn.watchdog.example.plist \
  ~/Library/LaunchAgents/com.jerome-group.ntulearn.watchdog.plist
# edit the copied plist
launchctl bootstrap "gui/$(id -u)" \
  ~/Library/LaunchAgents/com.jerome-group.ntulearn.watchdog.plist
```

It fires at about 05:00 through `StartCalendarInterval`. If the Mac is asleep then, launchd catches
up when it wakes; that catch-up-on-wake behaviour is why this schedule uses launchd rather than
cron. Installing or rehearsing the real LaunchAgent is the Owner's task because it changes this
machine and spends the saved NTULearn session.

The watchdog writes durable evidence in the state directory, the parent directory of the
configured `statePath`:

- `logs/<timestamp>-<uuid>.json` contains the captured run and attempt evidence.
- `latest.json` is the stable input for a future delivery channel. It contains `verdict`
  (`green`, `yellow`, or `red`), `message`, `timestamp` (the UTC finish time), and `runLog` (a
  path relative to the state directory):

```json
{
  "verdict": "green",
  "message": "synced, 0 new files",
  "timestamp": "2026-08-15T05:00:01.234Z",
  "runLog": "logs/2026-08-15T05-00-01-234Z-00000000-0000-0000-0000-000000000000.json"
}
```

Delivery reads this digest; it does not rerun the watchdog or re-derive the verdict from a log.

Point each destination at a dedicated `NTULearn` subfolder, so your own files in that course's
folder are never touched.

**One folder per NTULearn site, not per course.** A course often has more than one site — a lecture
site and a tutorial site are separate courses to NTULearn and each needs its own entry. Give the
main site `NTULearn` and each other site a sibling beside it, `NTULearn_Tutorial` and so on. Two
entries pointing at one folder, or at a folder inside another's, is refused at startup: they would
interleave their numbered trees, and a sync never deletes (`docs/adr/0003`), so untangling them
afterwards is hand work.

## What a sync does

Incremental and **additive**: unchanged downloads are skipped, and nothing is ever deleted, so a
run that sees less than the last one leaves the earlier files where they are. Occupied course files
are retained: differing downloaded bytes or generated text produce an actionable failure and a partial
receipt, including annotated stand-ins and earlier-number placements. Sync does not overwrite them,
create rescue copies or rename anything. Compare the retained file with NTULearn and choose an empty
destination before retrying — [ADR-0016](docs/adr/0016-occupied-course-files-require-manual-conflict-resolution.md).
Identical bytes are accepted without a write. Recorded actual byte counts avoid repeated downloads
when upstream sizes are inaccurate; these cached size checks do not prove content freshness or
integrity. Legacy records without byte counts are fetched and compared again. Page text and
announcements become Markdown; attachments keep their original file type. Each course gets a
`Course.md` overview and an `Announcements/` folder, and the content tree is reproduced as
numbered folders in NTULearn's own order. `Sync status.json`, `Last synced.md` and separate media
status publications remain machine-owned operational records and are rewritten; keep annotations
in course artifacts instead.

A file already in the destination under an earlier number is left where it is rather than written a
second time. A name carries its item's position in the course, so one item inserted upstream moves
every later name by one while nothing on disk moves — and a run that wrote to the new number would
leave the destination holding two of each, for good. The run counts those files as `renumbered`. It
compares the bytes before leaving anything in place, so a file whose contents differ is written at
today's number beside the older one and nothing is ever written over. A folder works the same way
and is where its children go, so a course that reorders keeps growing in the folder it already has
rather than starting a second one beside it; `docs/adr/0009` argues it, and `ls` keeps showing the
order the files arrived in.

A `Last synced.md` beside the overview records when the sync last ran for a person reading the
folder. A run over a course with nothing new writes no course document; the stamp still moves so
the attempt remains visible. `docs/adr/0008` argues both halves.

`Sync status.json` is the machine-readable receipt for that destination. A sync publishes
`running` before it reads the course, then `complete`, `partial`, or `failed`; an interrupted process
therefore leaves `running`. Only a complete attempt advances `lastSuccessfulAt`. Counts and unread
optional categories are retained, while course identifiers, paths, URLs, source text, and raw errors
stay out. The receipt excludes the media pipeline and proves neither exhaustive upstream visibility
nor current file bytes. It cannot authorize withdrawal, overwrite, or skipping a full curation walk.
Overlapping syncs remain possible, so it is a last-writer observation and should be read again when
freshness matters. Each attempt preserves the success it saw at startup; a later write from an older
overlapping attempt can therefore regress `lastSuccessfulAt` to an older value or `null`.
Malformed, unsupported, future-dated, oversized, or unreadable prior evidence preserves no claimed
success. The fresh `running` publication still has to succeed before NTULearn reads the course.

Academic OS reads the receipt through its separate `imports status` command. Deploying either
repository remains independent: an older destination simply has no receipt until its next sync, and
an older Academic OS ignores the importer-owned file. The shared v1 interface and rollout boundary
live in [Academic OS's import-status contract](https://github.com/Jerome-Group/academic-os/blob/main/docs/import-status-contract.md);
`docs/adr/0015` records this repository's producer decision.

An item a sync cannot copy — a quiz, a test, a submission point, anything holding no text, no link
and no attachment — still gets a Markdown file at its own numbered place, naming it and saying
there was nothing to bring across. The numbering stays continuous, and the copy never leaves out
something the course tells you to do; `docs/adr/0006` argues it.

A download that fails says where it was and where it would have gone, so the file can be found in
NTULearn without walking the course by hand:

```json
{
  "file": "Career_Platform_User_Guide.pdf",
  "trail": "(For EEE Students Only) Career Pathways Platform › Instruction Manual",
  "path": "09 (For EEE Students Only) Career Pathways Platform/03 Instruction Manual/01 Career_Platform_User_Guide.pdf",
  "error": "Download failed: HTTP 404"
}
```

A run prints one JSON object: `courses`, a row per course saying what that run did to it, and
`refused` beside it when there was one.

A course NTULearn will not hand over — closed at the end of its semester, or one the student is no
longer enrolled in — is named under `refused` and the run carries on to the next course. Both
`sync -- all` and `verify -- all` work this way: a closed course is permanent and there is nothing
to do about it, so it is reported rather than treated as the end of the run. A session that has
lapsed is the other case and still stops everything, because every course after it would fail the
same way and `npm run login` fixes them all at once.

```json
{
  "key": "SLAF01",
  "courseId": "_2694562_1",
  "reason": "NTULearn refused course _2694562_1 for this student (HTTP 403). …"
}
```

The saved Chrome profile in `.data/chrome-profile` is the reusable secret. It is
permission-restricted and ignored by Git. The university expires it periodically; run
`npm run login` again when that happens. Do not copy cookies into configuration files.

## Is a course complete?

A sync says what that run did. `npm run verify -- all` says what the destination holds: it walks
each configured course in NTULearn, works out the path of every file a sync would write there — the
attachments and the Markdown documents both — and reports which of those paths hold a file. It
downloads nothing and writes nothing on either side, and it exits `1` when anything is absent —
`docs/adr/0005`.

```json
{
  "files": 246,
  "attachments": 128,
  "documents": 118,
  "present": 236,
  "renumbered": 1,
  "complete": false,
  "courses": [
    {
      "key": "CC0006",
      "course": "Sustainability: Seeing Through the Haze",
      "destination": "/…/CC0006/NTULearn",
      "files": 24,
      "attachments": 10,
      "documents": 14,
      "present": 22,
      "missing": [
        {
          "file": "Career_Platform_User_Guide.pdf",
          "trail": "Career Pathways Platform › Instruction Manual",
          "path": "09 Career Pathways Platform/03 Instruction Manual/01 Career_Platform_User_Guide.pdf"
        },
        {
          "file": "Video Lecture: Topic 1 - Introduction.md",
          "trail": "Week 1",
          "path": "01 Week 1/04 Video Lecture_ Topic 1 - Introduction.md"
        }
      ],
      "renumbered": [
        {
          "file": "Cengage WebAssign.md",
          "trail": "",
          "path": "02 Cengage WebAssign.md",
          "onDisk": "01 Cengage WebAssign.md"
        }
      ]
    }
  ],
  "refused": [
    {
      "key": "SLAF01",
      "courseId": "_2694562_1",
      "reason": "NTULearn refused course _2694562_1 for this student (HTTP 403). …"
    }
  ],
  "notCovered": ["A content item this walk did not return expects nothing, …"]
}
```

The gaps it names are fixed by running the sync again; it never repairs anything itself.

### A file whose number moved is not a gap

A file's name carries its item's position in the course, so one item inserted upstream moves every
later name by one — and nothing on disk moves with it, because a sync never renames
(`docs/adr/0003`). Those files are on disk under the number they were written with, so `verify`
counts them **present** and names them under `renumbered`, with `path` where a sync would write the
file today and `onDisk` where it actually is. Reporting them as missing would be a red that is
almost all noise.

What it does not do is repair the numbering, so `ls` shows the course in the order it had when each
file was written. A sync does not repair it either — it leaves those files where they are, so a
reordered course stops duplicating itself and stays in the order it arrived in (`docs/adr/0009`).
This list is what makes that drift legible, and `npm run renumber` is what answers it.

Two limits. It will not answer at all where two items in the same folder share a title: the name
inside the number identifies neither, so the file is reported missing rather than guessed at. And a
file left behind for an item NTULearn has stopped returning may carry the title of one that moved —
nothing but the bytes separates them, and `verify` never opens a file — so it is counted present.

## Putting a destination back in the course's order

`npm run renumber -- <course|all>` renames what the destination already holds so its numbers carry
the order NTULearn gives the course today. It is deliberately its own command: a rename is a delete
and a create to Google Drive and to anything holding a path to the file, which is not something to
do in a run nobody is watching. A sync never renames and never will — `docs/adr/0010` argues both
halves.

It renames only what it can prove the sync wrote and nothing has touched since — the `sha256` a
download recorded, or, for a Markdown document, the text the walk is holding. A file you have
annotated fails that check, is left exactly where it is, and is named under `kept` with the reason.
Nothing is deleted, nothing is written over, nothing moves between folders, and a name that already
holds something is reported under `blocked` rather than taken.

```json
{
  "renamed": 9,
  "kept": 1,
  "courses": [
    {
      "key": "MH2500",
      "course": "26S1-MH2500-PROBABILITY",
      "destination": "/…/MH2500/NTULearn",
      "renamed": [
        {
          "file": "Hand00_MH2500-2026.pdf",
          "trail": "",
          "from": "09 Hand00_MH2500-2026.pdf",
          "to": "10 Hand00_MH2500-2026.pdf"
        }
      ],
      "kept": [
        {
          "file": "Hand01_Part_1_MH2500-2026.pdf",
          "trail": "",
          "path": "09 Hand01_Part_1_MH2500-2026.pdf",
          "onDisk": "08 Hand01_Part_1_MH2500-2026.pdf",
          "why": "it has changed since the sync wrote it"
        }
      ]
    }
  ]
}
```

It exits `1` only when something was `blocked`. A `kept` file is the command working as intended,
and the report names it on every run so a destination that has gone permanently mixed says so.

**A rename breaks anything holding the old path as text** — a link from your own notes, a symlink, a
script. What survives is anything tracking the file rather than its name: a macOS alias, and a Google
Drive share link, since Drive carries a rename across and the file keeps its id. The digest proves
nobody edited the file; it proves nothing about who linked to it. That is the cost, and it is why you
run this rather than the sync doing it for you.

### What `complete: true` does not cover

The number counts **the files a sync would write, present at a path**, and it is worth reading as
narrowly as that says. The report carries a `notCovered` list saying so on every run.

It is also relative to one reading of the course, and that reading is named: the **walk** down
NTULearn's content-item tree, which is what a sync takes as its input and what `verify` counts
against (`docs/adr/0011`). Three other readings were tried and refused, so what follows is what the
walk does not cover rather than what nobody has got round to yet.

- **A content item the walk did not return** is in neither number: nothing expects what nothing
  saw, so the count it is missing from is a count it was never in. This is the blind spot the four
  gaps found so far all came out of, and every one was found by opening NTULearn in a browser
  rather than by the tool disagreeing with itself.
- **A category NTULearn would not return** — a course whose announcements the student may not read
  — expects nothing for the same reason, so the count passes over it. The course says `unread` when
  that has happened.
- **A course NTULearn would not hand over** is in neither number at all — it was never read, so
  nothing of it is counted as present or as missing. It is named under `refused`, and it does not
  make the run red: the course is closed, `npm run login` opens nothing, and a red that can never
  go green is one nobody reads. Read `complete: true` alongside that list, never instead of it.
- **Recorded lecture videos and their transcripts** are not read at all. The page naming the
  lecture is counted; whatever is on the other side of the link is absent from both sides of the
  number rather than counted as missing.
- **External tools** — anything reached through LTI — are recorded as a link, on the same terms.
- **Presence is not content.** `verify` asks the filesystem whether a file is at the path and
  nothing more, so a truncated, corrupt or since-replaced file counts as present
  (`docs/adr/0005`).
- **An embed this tool does not recognise** is one a sync never downloads and `verify` never
  expects, so both are silent about it together. What that has actually been measured to be is a
  video player's own output — the streams, thumbnails and caption tracks a Kaltura or YouTube
  player writes into the page after it starts — which is on the far side of the recorded-lecture
  limit above rather than a separate one (`docs/adr/0011`). What a page *carries* is not silent
  any more: an embedded `<iframe>`, `<object>` or `<embed>` leaves a `> **Not copied**` line where
  it sat, naming what was there. It is not counted, and it is said.
- **What the destination holds beyond the course is never looked at.** `verify` reads only at the
  paths NTULearn named, so a file kept for an item NTULearn has stopped returning is correct rather
  than reported — a destination only ever grows (`docs/adr/0003`). It reads a folder's listing for
  one question only, and about a name NTULearn did give it: whether the file is there under a
  number that has since moved.

So `complete: true` says that every file this tool knows to look for arrived. It does not say the
copy is the course.

## Limits

Only content visible to the signed-in student can be read. Release-rule-hidden content,
instructor-only material, live grades and submissions, and third-party LTI data are not copied;
external tools are recorded as links. What is not copied is written down where it sat, so a limit
shows up in the destination rather than only here.

## Working on it

```bash
npm ci
npm test                      # node --test
npm run lint                  # eslint
npm run format:check          # prettier
```

`AGENTS.md` is the instruction file for agents and contributors both; `CONTRIBUTING.md` is how
work flows here, and `MAP.md` says where everything lives.

## Historical transcript editions

`npm run --silent capabilities -- historical-transcripts` exposes the offline repair route. With the configured
course roots and Media store accessible, run `npm run media:format -- plan /absolute/private/plan.json`,
then explicitly authorized `npm run media:format -- apply /absolute/private/plan.json`;
`npm run media:format -- verify /absolute/private/plan.json` checks the published editions. Plan includes disabled courses, native/raw sources and unassociated derivatives.
No model, browser, network or acoustic reference is required. Apply requires RAID0, the configured
free-space reserve and exclusive media locking. It never changes original sources, original derivatives,
queues, state or media status. Keep private manifests and receipts out of the public repository.

The consistent policy joins source segments into paragraphs of at most eight segments or about
800 characters; long individual segments remain intact. Ordered words, spelling, case, numbers,
symbols and uncertainty remain guarded by the mandatory lexical check. HTML/login/error payloads,
encoding/control text and prompt/runtime banners block editions. Repetition is a review flag, not
evidence of hallucination. Timing/coverage failures and unknown duration remain explicit and cannot
become complete media through formatting. Missing, edited or ambiguous associations remain listed.

Each course gains `Transcript editions/source-paragraphs-v1-<plan-id>/index.md`, linking paragraph
editions, originals, sources, provenance and media status. Fresh names use recording identity;
exclusive hard-link publication refuses conflicting occupied bytes. Identical editions are reused.
Per-output receipts support interruption/retry without transactions, cleanup or a claim of universal
concurrent-editor safety. A changed source/provenance/queue invalidates the plan: inspect retained
partial editions, then create a new private plan. Reads have logical deadlines, not physical I/O
cancellation guarantees. The inventory bounds are 20,000 directory entries, depth 16, 4 MiB per
relevant file, 256 MiB of admitted reads/output per operation and a 120-second logical read budget.

The bounded owned-fixture check is `node --test test/media-historical.test.mjs test/media-historical-format.test.mjs test/media-historical-files.test.mjs test/media-historical-inventory.test.mjs`.
Use `npm run --silent media:format -- <plan|apply|verify> /absolute/private/plan.json` when
consuming the structured JSON result; exit 0 means passed, 1 failed and 2 usage/blocked.
