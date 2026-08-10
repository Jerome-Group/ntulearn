# NTULearn Sync

Central NTULearn downloader. Authentication and sync state stay here; course files go to each configured Google Drive module folder.

## Status

Early, and built in the open. Course pages, announcements and attachments sync today. Recorded
lecture videos, their transcripts, and transcription for the videos that have none are intended
and not yet built.

It is public from its first commit so that anyone who wants it while it is still being built can
run it — MIT licensed, `docs/adr/0002`. Expect it to change under you.

## Commands

```bash
npm run login                 # refresh NTU SSO/MFA session
npm run discover              # list accessible NTULearn courses
npm run sync -- MH2100        # sync one configured module
npm run sync -- all           # sync every configured module
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
| `courses[].key` | yes | What you type at `npm run sync -- <key>`. Matched case-insensitively, and must be unique across the file. The module code is the obvious choice. |
| `courses[].courseId` | yes | NTULearn's own identifier for the course, of the form `_1234567_1`. Run `npm run discover` to list the ones you can see. |
| `courses[].destination` | yes | Where the files land. Absolute, or relative to the repository root. |
| `profilePath` | no | The saved browser session. Defaults to `.data/chrome-profile`. |
| `statePath` | no | What has already been downloaded. Defaults to `.data/state.json`. |

Point each destination at a dedicated `NTULearn` subfolder, so unrelated module files remain
untouched.

The sync is incremental and non-destructive: unchanged downloads are skipped and stale files are not deleted. Useful page text and announcements are Markdown. Original attachments retain their file type.

The saved Chrome profile in `.data/chrome-profile` is the reusable secret. It is permission-restricted and ignored by Git. The university may expire it; run `npm run login` again when that happens. Do not copy cookies into configuration files.

Limits: only content visible to the logged-in student can be read. Release-rule-hidden content, instructor-only material, live grades/submissions, and third-party LTI data are not mirrored. External tools are recorded as links.
