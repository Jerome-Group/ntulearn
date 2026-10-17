# Map

Syncs NTULearn course content — pages, announcements and attachments — into a folder per course.

Start here: `README.md`, then `AGENTS.md`.

Machine entry point: `npm run capabilities`; verification: `npm run check`;
offline operational observations: `npm run health`, `npm run status`.

| Area | What lives there | Entry point |
|------|------------------|-------------|
| Commands | Login, course discovery, additive sync, verify, renumber and watchdog | `src/cli.mjs`, `src/watchdog/`, `src/courses.mjs`, `src/output.mjs`, `package.json` |
| Capabilities | Machine command/feature index, shared CI/agent checks with explicit bounded private failure evidence, and offline health/status | `src/capabilities/`, `npm run capabilities`, `npm run check` |
| Configuration | Reading `config/courses.json` — which courses sync, where each one goes and physical course-tree overlap checks. The tracked example is the documented shape | `src/config.mjs`, `config/courses.example.json` |
| NTULearn | Everything that speaks to NTULearn: the saved session and browser signal ownership, the read API, and the fields read off a content item | `src/ntulearn/` |
| Verification driver | Real CLI journeys, retained proof and feature map | `.agents/skills/verify/SKILL.md`, `.agents/skills/verify/features/README.md` |
| Sync | Everything that has a destination in hand: the course walk and its portable receipt, occupied-file conflict protection, additive identity/revision source editions, where each file lands, the Markdown documents, what has already been downloaded, the read that holds it against NTULearn, and the one command that renames in it | `src/sync/` |
| Local state | The saved browser session and the sync state. Ignored, never committed | `.data/` (untracked) |
| Scratch destinations | Destinations this repository owns, for trying something against a course without writing into a real one. Ignored, never committed | `.scratch/` (untracked) |
| Tests | Focused contracts and regressions, including process-level CLI checks | `test/` |
| Toolchain | Prettier formats this repository's own code, ESLint checks correctness only, and the supported Node range is enforced at install rather than warned about | `.prettierrc.json`, `eslint.config.mjs`, `.npmrc` |
| Working here | Agent + contributor conventions, commit/attribution rules | `AGENTS.md` (= `CLAUDE.md`) |
| Contributing | How work flows here — issue first, then a pull request | `CONTRIBUTING.md` |
| Code standards | How code is written and reviewed | `CODING_STANDARDS.md` |
| Domain language | The glossary — this repository's ubiquitous language | `CONTEXT.md` |
| Decisions | Architecture decision records | `docs/adr/` |
| Research | Primary-source findings, including historical media research marked retired | `docs/research/` |
| Agent skills | The routines an agent follows here, one file per skill | `docs/agents/` |
| Automation | The workflows that run on a pull request or on a new issue, and dependency updates | `.github/` |

Update this file in the same pull request whenever a top-level area is added, moved, or removed.
