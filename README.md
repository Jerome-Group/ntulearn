# NTULearn Sync

Signs in to NTULearn once and keeps a copy of your courses on disk: pages and announcements as
Markdown, attachments as the files they already are. Authentication and sync state stay in this
repository; course files go to whichever folder you point each course at.

MIT licensed and public — `docs/adr/0002`.

## Status

In use. Course pages, announcements and attachments sync today. Audio and video supplied as
ordinary course attachments are copied unchanged. Lecture Media Gallery capture and all transcript
processing are retired. External players remain links. See [ADR-0028](docs/adr/0028-retire-gallery-and-transcript-processing.md).

## Commands

Start with `npm run capabilities`: its versioned JSON index lists prerequisites, Owner restrictions,
read/write effects, arguments, implementation and fixture verification routes. It needs no local
configuration or browser installation. Select a command or feature with
`npm run capabilities -- sync`.

Use `npm run --silent capabilities` for JSON without npm's banner. The index describes result
fields and command-specific effects. `NTULEARN_CONFIG_PATH` selects an absolute or checkout-relative
private configuration file; relative values inside it still resolve from the checkout root.

```bash
npm run health               # offline config/filesystem observations; never opens the session
npm run status               # offline receipts and watchdog digest freshness; no source contents
npm run check                # shared CI/agent syntax, contracts, format, lint and fixture checks
npm run check -- test        # one check; unselected checks explicitly unrun
```

These three commands emit `schemaVersion: 1`, per-check `passed`, `failed`, `blocked` or `unrun`,
actions and bounded evidence. Exit codes: `0` passed, `1` failed, `2` blocked/unrun/usage. Health
reads only profile directory metadata; it does not validate login. Status counts sync receipts
and watchdog evidence, treating evidence older than 48 hours as stale. Neither proves upstream
visibility or artifact bytes. Private course paths, identifiers, raw errors and log contents are excluded.

`npm ci --ignore-scripts`, then `npm run check` is the clean-checkout verification route. It runs
the existing `npm test`, `npm run lint` and `npm run format:check` tools plus ESM syntax and catalog
contracts, without browser/network tests. Each check is bounded to two minutes and all selected
checks report even after another fails. Evidence includes elapsed time, exit code and output hash;
the default reports no raw output. A repeat that passes does not explain an earlier failure.
For original failure evidence, request a fresh private directory through the same CI/agent entrypoint:

```bash
npm run --silent check -- test --evidence .scratch/check-evidence-investigation1
npm run --silent check -- --evidence .scratch/check-evidence-investigation2
```

Only fresh direct children named `check-evidence-` followed by 1–80 letters/digits/underscores/hyphens
under this checkout's `.scratch` are permitted. Occupied/foreign/profile/runtime/symlink targets refuse;
no configuration, profile or runtime contents are inspected. Created directories are 0700 and files
0600. Parent/descriptor identities and retained file bytes are checked; these bounded observations
cannot promise atomic exclusion of every external filesystem mutation.
The JSON locator `requested-private-evidence/test-001` means `test-001.invocation.json`,
`test-001.stdout.log` and `test-001.stderr.log` in the directory you requested. It contains only fixed
filenames, digests, byte counts and exit codes; never the requested path/name, command arguments or raw
assertions. Inspect these private files before retrying. Raw logs are not uploaded or printed by this
route; CI may explicitly use the same flag without changing its entrypoint or publishing artifacts.
Each stdout/stderr prefix is limited to 2 MiB; truncation and the full captured bytes/digest are separate.
Invocation metadata is 64 KiB, the result snapshot 128 KiB, at most 17 files/21 MiB. Evidence I/O is
bounded to 5 seconds per operation, 30 seconds cumulative (excluding check execution), plus up to
5 seconds for positive settlement. Existing check deadlines, output stop limits and exit codes remain.
Evidence failures remain separate from original check failures. Unconfirmed I/O/cleanup stops further
checks/evidence writes, retains partial files and requires inspection before retry; it grants no green
result. `run.result.json` is a snapshot marked pending final settlement, not a completion grant. The
returned `complete` and cleanup observations are authoritative for evidence settlement. No file is
replaced or pruned; recovery requires a fresh requested directory. Old digest-only failures cannot
recover their original assertions and are not retroactively claimed fixed by a later passing run.

No TypeScript is present: syntax, lint, runtime contracts and fixture/process regressions are the applicable checks.

```bash
npm run login                 # refresh the NTU SSO/MFA session
npm run discover              # list the NTULearn courses you can see
npm run watchdog              # run sync and verify under the daily-run watchdog
npm run sync -- MH2100        # sync one configured course
npm run sync -- all           # sync every configured course
npm run verify -- all         # check what is on disk against NTULearn, writing nothing
npm run renumber -- MH2500    # rename what is on disk back into the course's order today
```

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
  "courses": [
    {
      "key": "AB1234",
      "courseId": "_0000000_1",
      "destination": "/absolute/path/to/Google Drive/My Drive/Modules/Y1S1/AB1234/NTULearn"
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

Legacy `media` and `courses[].mediaMode` settings are ignored. Remove them from private
configuration when convenient; they no longer enable processing or require a Media store.

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
receipt, including annotated stand-ins and earlier-number placements. Sync never overwrites or renames
occupied files. Distinct attachments whose names collide receive stable identity suffixes. Revised
attachments, content-item pages and announcements receive immutable identity/digest editions alongside
the original. Page and announcement Markdown editions link retained originals when known; attachment
provenance records the association. Existing legacy files and user edits remain intact. Edited current editions or
occupied different suffixes remain conflicts; compare them with NTULearn before retrying.
[ADR-0019](docs/adr/0019-source-editions-add-distinct-identities-and-announcement-revisions.md) and
[ADR-0027](docs/adr/0027-source-revisions-preserve-occupied-originals.md) narrow
[ADR-0016](docs/adr/0016-occupied-course-files-require-manual-conflict-resolution.md).

Positive identity/path/SHA-256 evidence preserves recorded placements through reorder, later siblings
and removed siblings. Exclusive checksum-named records under `Source editions/<identity>/` keep that
placement evidence in the course destination; each identity admits at most 128 records of 64 KiB each.
New suffixed filename leaves stay within 160 UTF-8 bytes. Missing/ambiguous identities and malformed
provenance refuse rather than guess. Losing State never grants ownership to an ambiguous legacy file.
Sync checks current digests before reusing source files; inaccurate upstream sizes alone do not trigger
a fetch. Changed attachment fingerprints trigger a revision probe; fetched bytes determine the revision.
Publication fetches again and refuses if the bytes differ from the probe or recorded revision.
An unchanged fingerprint cannot reveal changed upstream bytes unless a later run fetches them. Legacy
attachment provenance without a fingerprint needs matching State and current file hashes to acquire a
current association without a fetch. With only legacy provenance and no State, sync probes and fetches
again at publication. Verify reports those legacy
attachments missing until current association exists, then selects that revision without downloading.
With no provenance or State, sync accepts equal fetched attachment bytes at the retained path or adds
a digest edition for different bytes. Legacy pages and attachments without provenance can still count
as present by path before sync; this presence does not establish their current version.
Query/session-bearing addresses are hashed in new attachment cache records rather
than retained. CLI results and the compatible version-1 receipt expose `newEditions`, `reusedFiles`,
`unresolvedIdentity` and `publicationConflicts`. Verify shares placement resolution and checks presence;
it reads bounded source-placement metadata and may hash retained legacy attachments. It reads no
State or upstream attachment bytes and proves neither freshness, fidelity nor exhaustive upstream
visibility. Page text and announcements remain Markdown;
attachments retain their original type. Course overview, announcements and numbered course folders
keep their established layout. Machine receipts and stamps remain operational
publications; put annotations in course artifacts instead.

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
stay out. The receipt describes the course sync and proves neither exhaustive upstream visibility
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

It selects the current source revision before proving permission to move it. Attachments require a
State digest and compatible source identity. Their held bytes must match that digest, and current
provenance, when present, must agree too. Losing State still prevents attachment renumbering.
Ordinary Markdown documents require the text the walk
is holding. A positively recorded current page instead requires its rendered-source revision and
the complete accepted digest, including its immutable edition footer. That footer can retain an old
link after a parent rename; sync preserves its accepted bytes. [ADR-0029](docs/adr/0029-current-page-renumber-proof.md)
records this narrow proof change. An annotated file fails the proof, stays at its held leaf name,
and appears under `kept` with the reason.
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
npm ci --ignore-scripts
npm test                      # node --test
npm run lint                  # eslint
npm run format:check          # prettier
```

`AGENTS.md` is the instruction file for agents and contributors both; `CONTRIBUTING.md` is how
work flows here, and `MAP.md` says where everything lives.

The project verification driver is [`.agents/skills/verify/SKILL.md`](.agents/skills/verify/SKILL.md).
Its feature map records offline proofs and the live checks reserved for the Owner.
