# Map

Syncs NTULearn course content — pages, announcements and attachments — into a folder per course.

Start here: `README.md`, then `AGENTS.md`.

Machine entry point: `npm run capabilities`; verification: `npm run check`;
offline operational observations: `npm run health`, `npm run status`.

| Area | What lives there | Entry point |
|------|------------------|-------------|
| Commands | The CLI — `login`, `discover`, `watchdog`, `sync`, `verify`, `renumber`, `media:discover`, `media:worker`, `media:withdraw`, and `media:evaluate`, and `media:format` — the `npm run` scripts that reach it, what one course refusing does to the rest of a run, and how a line gets out before the process exits | `src/cli.mjs`, `src/watchdog/`, `src/courses.mjs`, `src/output.mjs`, `package.json` |
| Capabilities | Machine command/feature index, shared CI/agent checks and bounded offline health/status evidence | `src/capabilities/`, `npm run capabilities`, `npm run check` |
| Configuration | Reading `config/courses.json` — which courses sync, where each one goes and physical course-tree overlap checks. The tracked example is the documented shape | `src/config.mjs`, `config/courses.example.json` |
| NTULearn | Everything that speaks to NTULearn: the saved session and browser signal ownership, the read API, and the fields read off a content item | `src/ntulearn/` |
| Media workflow | Explicit media modes, RAID0 runtime/setup, current content-tree/Gallery authority, isolated course discovery contexts, metadata/navigation read guard, observed supplied Gallery launch and guarded product-announcement Close, queues, manual priority/interruption, guarded retry, providers, bounded remux diagnostics, source paragraphs/review, verified reading catalogue with independent retained-media access and positively bound retained course aliases, aggregate metadata safety and artifacts | `src/media/`, `npm run media:setup`, `npm run media:discover`, `npm run media:worker`, `npm run media:retry`, `npm run media:catalogue`, `src/media/catalogue*.mjs` |
| Historical transcript repair | Offline inventory, paragraph formatting, fresh editions and course access indexes | `src/media/historical*.mjs`, `npm run media:format` |
| Source recovery | Owned retained-media ASR candidates, explicit decoder policies, optional pinned VAD setup/receipts and incomplete-source absence/state proofs, native validation and exclusive lecture editions | `src/media/recovery*.mjs`, `src/media/vad*.mjs`, `npm run media:recover`, `npm run media:setup -- vad` |
| Transcript evaluation | Bounded offline plan/run, immutable source/reference provenance, separate alignment/timing/formatting verdicts and private evidence | `src/media/evaluation*.mjs`, `npm run media:evaluate` |
| Sync | Everything that has a destination in hand: the course walk and its portable receipt, occupied-file conflict protection, additive identity/revision source editions, where each file lands, the Markdown documents, what has already been downloaded, the read that holds it against NTULearn, and the one command that renames in it | `src/sync/` |
| Local state | The saved browser session and the sync state. Ignored, never committed | `.data/` (untracked) |
| Scratch destinations | Destinations this repository owns, for trying something against a course without writing into a real one. Ignored, never committed | `.scratch/` (untracked) |
| Tests | One file per module under test, plus the two that spawn the CLI to check what only a process shows | `test/` |
| Toolchain | Prettier formats this repository's own code, ESLint checks correctness only, and the supported Node range is enforced at install rather than warned about | `.prettierrc.json`, `eslint.config.mjs`, `.npmrc` |
| Working here | Agent + contributor conventions, commit/attribution rules | `AGENTS.md` (= `CLAUDE.md`) |
| Contributing | How work flows here — issue first, then a pull request | `CONTRIBUTING.md` |
| Code standards | How code is written and reviewed | `CODING_STANDARDS.md` |
| Domain language | The glossary — this repository's ubiquitous language | `CONTEXT.md` |
| Decisions | Architecture decision records | `docs/adr/` |
| Research | Findings from primary documentation, one file per question; platform containment design and qualification routes | `docs/research/`, `docs/research/platform-containment-design.md` |
| Agent skills | The routines an agent follows here, one file per skill | `docs/agents/` |
| Automation | The workflows that run on a pull request or on a new issue, and dependency updates | `.github/` |

Update this file in the same pull request whenever a top-level area is added, moved, or removed.
