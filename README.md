# NTULearn Sync

Central NTULearn downloader. Authentication and sync state stay here; course files go to each configured Google Drive module folder.

## Commands

```bash
npm run login                 # refresh NTU SSO/MFA session
npm run discover              # list accessible NTULearn courses
npm run sync -- MH2100        # sync one configured module
npm run sync -- all           # sync every configured module
```

Configure modules in `config/courses.json`. Each destination should be a dedicated `NTULearn` subfolder so unrelated module files remain untouched.

The sync is incremental and non-destructive: unchanged downloads are skipped and stale files are not deleted. Useful page text and announcements are Markdown. Original attachments retain their file type.

The saved Chrome profile in `.data/chrome-profile` is the reusable secret. It is permission-restricted and ignored by Git. The university may expire it; run `npm run login` again when that happens. Do not copy cookies into configuration files.

Limits: only content visible to the logged-in student can be read. Release-rule-hidden content, instructor-only material, live grades/submissions, and third-party LTI data are not mirrored. External tools are recorded as links.
