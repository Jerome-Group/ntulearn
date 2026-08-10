# Coding standards

This file is what `/code-review`'s **Standards** axis reads. It is layered:

- **The core** (§1–§5) — shared by every repository, seeded from the template. Treat it as
  fixed; it changes only by an org-level decision (see §7).
- **Repo-specific standards** (§6) — each repository fills these in and evolves them freely.

## 1. The principle: the code explains itself

Every unit is written to be understood from the code alone by the next reader — increasingly
an LLM agent — so that reader can take exactly what it needs without a human in the loop. Prose
is a poor substitute for legible code: if a piece of code needs a paragraph to be understood,
the code is wrong, not under-documented. **The burden is on the code, not on the docs.**

## 2. What the code must do

These are checkable; `/code-review` holds a change against them.

- **Self-explanatory.** Names state what a thing is and does; control flow reads plainly. No
  cleverness that needs a comment to decode. A comment earns its place only for a genuine *why*
  the code cannot carry (a workaround, a non-obvious constraint) — never to restate *what*.
- **Placed predictably.** Files live where their purpose says they belong — the file system is
  itself a map. A reader guesses where something lives from its role and is right.
- **Small, cohesive units.** One concern per file and per function, sized so an agent can load
  it and reason about it without dragging in the whole repository.
- **Interface separated from implementation.** The public surface — types, signatures, the
  contract — is separable from how it is carried out, so a reader takes just the interface it
  needs and ignores the rest.
- **Deep, not shallow.** A unit's public surface is small relative to what it does, and it hides
  its internals. Prefer a few powerful, well-named entry points over many thin pass-throughs.
- **Few, obvious dependencies.** What a unit needs is explicit at its edge, not reached for
  through globals or hidden state. Minimise what a reader must hold in their head at once.
- **Formatted by tooling, not by hand.** Formatting and lint are automated so they are never a
  review topic; review is about design, not whitespace.
- **No dead weight.** No unused code, commented-out blocks, or speculative generality. If it
  isn't used now, it isn't here.

## 3. Documentation boundary

Docs carry only what the code cannot say — the *why*, the decisions, the domain language, the
constraints outside the code. That layer already exists and is required:

- **`docs/adr/`** — the decisions and their rationale.
- **`CONTEXT.md`** — the ubiquitous language (the glossary).

Do not narrate the code in prose. If you are writing documentation that explains *what the code
does*, fix the code until it says so itself.

## 4. `MAP.md` is required

Every repository carries a **`MAP.md`** at its root — a one-screen orientation map so an agent
finds its way fast. This is navigation, not explanation: it points at where things are; it never
restates what the code already says. Keep it light so it stays true:

- One line: what this repository is.
- The top-level areas **only** — each a single line: *what lives there* and its *entry point*.
  Do not mirror the directory tree; list the handful of places that matter.
- A "start here" pointer for a newcomer.

`MAP.md` is part of the definition of done: a change that adds, moves, or removes a top-level
area updates `MAP.md` in the **same** pull request. A stale map is worse than none, so
`/code-review` treats a drifted `MAP.md` as a Standards finding.

## 5. What CI must prove

The core makes one claim about a repository's own checks; everything else about them is §6's
business. Two obligations:

- **CI proves this repository's own artefact.** From a clean checkout, with no manual step, the
  run builds what the repository produces and runs one formatter and one linter in check mode,
  plus the tests. Where the artefact is not code — Terraform, a set of documents, a template
  tree — the obligation is unchanged and only the commands differ: run whatever would catch that
  artefact being wrong.
- **The whole run finishes inside ten minutes.** Past that, developers route around it and a
  failure stops naming one change. A suite outgrowing the bound is a signal to split the check,
  not to raise the bound.

How the checks grow forks on **cost**, which is countable, rather than on importance, which is
not:

- **Structural checks are added on sight** — deterministic, sub-second, needing no judgement.
- **A behavioural check waits until the mistake has happened three times.** Anything cheaper to
  write than to be wrong about is already covered by the line above; the rest is a guess until
  the failure has a history.
- **A bug fix always carries the check that would have caught it**, whichever kind it is. The
  mistake has happened, so there is nothing left to estimate.

Two shapes are settled, so no repository re-argues them:

- **One workflow file for the checks, many jobs.** Jobs already give the parallelism and the
  separate check contexts, so a second file buys neither and splits the place a reader looks. A
  workflow that is not a check — an automation that acts on a merge — is its own file. So is
  `conformance.yml`, and for a reason the rule was never about: that file is not this repository's
  to own. It arrives written, its pin is moved by Dependabot, and folding it into `ci.yml` would
  make every rule the Organisation agrees an edit to a file this repository owns.
- **No path filters.** A filtered workflow never reports on a pull request it does not match, so
  a required check sits pending forever and the merge blocks on a report that will never arrive.

## 6. Repo-specific standards

**Node, ESM, `.mjs`.** No transpiler and no build step: what is committed is what runs, so a
stack frame points at a real line and there is nothing to rebuild before a change takes effect.

**`engines.node` is the intersection with the toolchain, not a guess.** It reads
`^22.13.0 || >=24` rather than `>=22` because the eslint packages exclude 22.0–22.12 and the whole
of 23.x, and a manifest that promises a Node the linter refuses is a promise made to the one
person CI cannot see. `.npmrc` sets `engine-strict`, so a Node outside the range fails `npm ci`
instead of warning past it. Recompute the range when a dependency raises its floor; do not
simplify it back.

**Prettier formats, ESLint checks correctness**, and neither is ever a review topic. Prettier is
scoped to this repository's own code — `.prettierignore` keeps it off the Markdown and the
workflows, which arrive written from the management hub and are not ours to reflow. ESLint's
config carries no whitespace rule, so the two can never disagree.

**Two layers, and the arrow only points one way.** `src/ntulearn/` speaks to NTULearn; `src/sync/`
writes to disk. Sync imports from NTULearn — never the reverse — and `src/cli.mjs` is the only
file that knows about both, about `process`, or about the argument list.

**A module that touches the network is separable from one that does not.** Everything that can be
tested without a browser is in a file that does not import `playwright`, which is why the
NTULearn addresses live in `src/ntulearn/urls.mjs` rather than beside the session that uses them.
Adding an import that drags Playwright into a pure module is the mistake this rule exists to
catch.

**Tests are `test/*.test.mjs`, one file per module under test, run by `node --test`.** They use no
framework and no network. The seam is the pure function: names, Markdown, content fields,
configuration and state are all tested directly; the browser session and the HTTP client are
thin enough to be read instead.

**What only the process can show, a child process checks.** An exit code, a usage line on stderr,
whether a large write survives the exit — none of those are observable from inside the process
that has them, so `test/cli.test.mjs` and `test/output.test.mjs` spawn one and read it back.
Everything in `test/` still runs without a network and without a browser, and that is the line
worth keeping rather than a rule against subprocesses.

**Errors carry the next action.** A message that a person will see says what to do about it —
`Run: npm run login`, `Copy config/courses.example.json` — because the alternative is a correct
sentence that leaves the reader where they were.

## 7. Evolution — what is rigid, what moves

- **The core (§1–§5) is rigid.** It is identical in every repository and changes only by an
  org-level decision recorded as an ADR in the management hub, then rolled out through the
  template (and to existing repositories as wanted). Do not quietly edit the core in one repo.
- **§6 moves freely** per repository, through that repository's own pull requests.
- **`MAP.md` is required everywhere, but its contents are repo-specific** and are updated
  continuously alongside the code they describe.
