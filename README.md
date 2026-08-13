# NTULearn Sync

Signs in to NTULearn once and keeps a copy of your courses on disk: pages and announcements as
Markdown, attachments as the files they already are. Authentication and sync state stay in this
repository; course files go to whichever folder you point each course at.

MIT licensed and public — `docs/adr/0002`.

## Status

In use. Course pages, announcements and attachments sync today, and the command line and the
shape of `config/courses.json` are settled — a change to either would be a breaking change rather
than a Tuesday. Recorded lecture videos and their transcripts are not read yet; that is the next
thing, and its absence is a missing feature rather than an unfinished one.

## Commands

```bash
npm run login                 # refresh the NTU SSO/MFA session
npm run discover              # list the NTULearn courses you can see
npm run sync -- MH2100        # sync one configured course
npm run sync -- all           # sync every configured course
npm run verify -- all         # check what is on disk against NTULearn, writing nothing
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
| `courses[].destination` | yes | Where the files land. Absolute, or relative to the repository root. No two courses may share one, or nest one inside another. |
| `profilePath` | no | The saved browser session. Defaults to `.data/chrome-profile`. |
| `statePath` | no | What has already been downloaded. Defaults to `.data/state.json`. |

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
run that sees less than the last one leaves the earlier files where they are. Your own files in a
destination are safe for the same reason — `docs/adr/0003` argues it. Page text and
announcements become Markdown; attachments keep their original file type. Each course gets a
`Course.md` overview and an `Announcements/` folder, and the content tree is reproduced as
numbered folders in NTULearn's own order.

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
almost all noise, and worse: the remedy it prints is `npm run sync`, which would download every one
of them again under its new number and leave the destination holding two of each, for good.

What it does not do is repair the numbering, so `ls` shows the course in the order it had when each
file was written. The one case it will not answer is two items in the same folder sharing a title:
the name inside the number identifies neither, so a file that is not at its own number is reported
missing rather than guessed at.

### What `complete: true` does not cover

The number counts **the files a sync would write, present at a path**, and it is worth reading as
narrowly as that says. The report carries a `notCovered` list saying so on every run.

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
  expects, so both are silent about it together.
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
