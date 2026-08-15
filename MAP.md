# Map

Syncs NTULearn course content — pages, announcements and attachments — into a folder per course.

Start here: `README.md`, then `AGENTS.md`.

| Area | What lives there | Entry point |
|------|------------------|-------------|
| Commands | The CLI — `login`, `discover`, `watchdog`, `sync`, `verify`, `renumber` — the `npm run` scripts that reach it, what one course refusing does to the rest of a run, and how a line gets out before the process exits | `src/cli.mjs`, `src/watchdog/`, `src/courses.mjs`, `src/output.mjs`, `package.json` |
| Configuration | Reading `config/courses.json` — which courses sync, and where each one goes. The tracked example is the documented shape | `src/config.mjs`, `config/courses.example.json` |
| NTULearn | Everything that speaks to NTULearn: the saved session, the read API, and the fields read off a content item | `src/ntulearn/` |
| Sync | Everything that has a destination in hand: the course walk that writes to it, where each file lands, the Markdown documents, what has already been downloaded, the read that holds it against NTULearn, and the one command that renames in it | `src/sync/` |
| Local state | The saved browser session and the sync state. Ignored, never committed | `.data/` (untracked) |
| Scratch destinations | Destinations this repository owns, for trying something against a course without writing into a real one. Ignored, never committed | `.scratch/` (untracked) |
| Tests | One file per module under test, plus the two that spawn the CLI to check what only a process shows | `test/` |
| Toolchain | Prettier formats this repository's own code, ESLint checks correctness only, and the supported Node range is enforced at install rather than warned about | `.prettierrc.json`, `eslint.config.mjs`, `.npmrc` |
| Working here | Agent + contributor conventions, commit/attribution rules | `AGENTS.md` (= `CLAUDE.md`) |
| Contributing | How work flows here — issue first, then a pull request | `CONTRIBUTING.md` |
| Code standards | How code is written and reviewed | `CODING_STANDARDS.md` |
| Domain language | The glossary — this repository's ubiquitous language | `CONTEXT.md` |
| Decisions | Architecture decision records | `docs/adr/` |
| Research | Findings from reading somebody else's documentation, one file per question | `docs/research/` |
| Agent skills | The routines an agent follows here, one file per skill | `docs/agents/` |
| Automation | The workflows that run on a pull request or on a new issue, and dependency updates | `.github/` |

Update this file in the same pull request whenever a top-level area is added, moved, or removed.
