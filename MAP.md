# Map

Syncs NTULearn course content — pages, announcements and attachments — into a folder per course.

Start here: `README.md`, then `AGENTS.md`.

| Area | What lives there | Entry point |
|------|------------------|-------------|
| Commands | The CLI — `login`, `discover`, `sync` — and the `npm run` scripts that reach it | `src/cli.mjs`, `package.json` |
| Configuration | Reading `config/courses.json` — which courses sync, and where each one goes. The tracked example is the documented shape | `src/config.mjs`, `config/courses.example.json` |
| NTULearn | Everything that speaks to NTULearn: the saved session, the read API, and the fields read off a content item | `src/ntulearn/` |
| Sync | Everything that writes to a destination: the course walk, the Markdown documents, the file names, and what has already been downloaded | `src/sync/` |
| Local state | The saved browser session and the sync state. Ignored, never committed | `.data/` (untracked) |
| Tests | `node --test`, one file per module under test; run with `npm test` | `test/` |
| Formatting and lint | Prettier formats this repository's own code; ESLint checks correctness only | `.prettierrc.json`, `eslint.config.mjs` |
| Working here | Agent + contributor conventions, commit/attribution rules | `AGENTS.md` (= `CLAUDE.md`) |
| Contributing | How work flows here — issue first, then a pull request | `CONTRIBUTING.md` |
| Code standards | How code is written and reviewed | `CODING_STANDARDS.md` |
| Domain language | The glossary — this repository's ubiquitous language | `CONTEXT.md` |
| Decisions | Architecture decision records | `docs/adr/` |
| Agent skills | The routines an agent follows here, one file per skill | `docs/agents/` |
| Automation | The workflows that run on a pull request or on a new issue, and dependency updates | `.github/` |

Update this file in the same pull request whenever a top-level area is added, moved, or removed.
