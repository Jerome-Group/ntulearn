# Map

Imports NTULearn course content — pages, announcements and attachments — into per-module folders.

Start here: `README.md`, then `AGENTS.md`.

| Area | What lives there | Entry point |
|------|------------------|-------------|
| Commands | The CLI — `login`, `discover`, `sync` — and the `npm run` scripts that reach it | `src/cli.mjs`, `package.json` |
| Sync | Walking a course and writing what changed; incremental and non-destructive | `src/sync.mjs` |
| NTULearn | The authenticated client — session reuse, course listing, content fetch | `src/ntulearn.mjs` |
| Output | Page text and announcements to Markdown; where each file lands on disk | `src/markdown.mjs`, `src/paths.mjs` |
| Configuration | Reading `config/courses.json` — which modules sync, and where each one goes | `src/config.mjs` |
| Local state | The saved browser session and sync state. Ignored, never committed | `.data/` (untracked) |
| Tests | `node --test`; run with `npm test` | `test/` |
| Working here | Agent + contributor conventions, commit/attribution rules | `AGENTS.md` (= `CLAUDE.md`) |
| Contributing | How work flows here — issue first, then a pull request | `CONTRIBUTING.md` |
| Code standards | How code is written and reviewed | `CODING_STANDARDS.md` |
| Domain language | The glossary — this repository's ubiquitous language | `CONTEXT.md` |
| Decisions | Architecture decision records | `docs/adr/` |
| Agent skills | The routines an agent follows here, one file per skill | `docs/agents/` |
| Automation | The workflows that run on a pull request or on a new issue, and dependency updates | `.github/` |

Update this file in the same pull request whenever a top-level area is added, moved, or removed.
