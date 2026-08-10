# AGENTS.md — ntulearn

> `CLAUDE.md` is a symlink to this file. Edit this one; both change.

## What this repo is

A command-line sync from NTULearn into a folder per course: it signs in as the student once,
reads each configured course, and writes the pages and announcements as Markdown alongside the
original attachments. Everything it does upstream is a **read** — it stays within what the
signed-in student can already see, and it leaves NTULearn exactly as it found it. Course files
live wherever the local configuration points; this repository holds the code and nothing a
student owns.

- **Visibility:** public
- **Organisation:** [Jerome-Group](https://github.com/Jerome-Group)

## Getting it running

`package.json` holds the scripts. What it cannot tell you: `npm ci --ignore-scripts` is enough for
everything but running the tool — it skips Playwright's browser download, and nothing under
`test/` needs a browser or a network, which is the property `CODING_STANDARDS.md` §6 exists to
hold. CI installs that way. A fresh clone has no `config/courses.json`; copy the example.

`npm run login`, `npm run discover` and `npm run sync` reach NTULearn as a real signed-in student
and write to real folders on this machine. Change them, test the pure parts, and leave the running
to the Owner: `login` needs a person at the MFA prompt, and the other two need a live session that
only `login` produces.

## Conventions

- Default branch: `main`.
- Keep secrets out of the repo — a credential belongs in the environment or a secret store, and
  an example value belongs behind a `# gitleaks:allow` that asserts it opens nothing. The
  conformance check scans every pull request, and it fires after the push, so a caught credential
  is already burned: rotate it first, then clean up. The full response is in `CONTRIBUTING.md`.

## Code standards

`CODING_STANDARDS.md` is the full version: the burden is on the code, not on docs — names,
placement and small cohesive units carry the *what*, and docs carry only the *why*. `MAP.md` is
required at the root and updated in the same pull request as any top-level change.

## How work flows

`CONTRIBUTING.md` here is the full version — the Organisation's, copied so it is a file an agent
can read. In short: an issue first, then a pull request; no commit lands on `main` directly.

**A change to this repository's files is finished when its pull request is open — not when the
commit exists.** Branch, commit, **push, and open the pull request**, without asking whether to;
nothing is merged by them. This outranks any instruction that stops earlier — a skill whose last
step is "commit your work" has described the middle of the job. It reaches file changes and
nothing else: a session that changes no file owes no pull request, and the only other thing that
stops you is the author saying, here, that they want the commit alone.

## Commit & PR attribution

Every commit **you write**, and every pull-request body, ends with an `Assisted-by:` trailer —
plus a `Co-authored-by:` for a model whose vendor address is verified — as its **last,
contiguous** lines. Wrote it yourself? Then it is `Assisted-by: none`, never no trailer at all.
The commits GitHub writes are not yours: the squash on `main` and the merge the **Update branch**
button makes are the platform's text, so leave them as they are — the check skips a merge commit
and never runs over `main`. The full rule and the verified allowlist are in `CONTRIBUTING.md`; an
effort suffix is recorded only when one is explicitly set, and a mode (Ultracode) is a mode rather
than an effort.

## Agent skills

### The route through the skills

Read `docs/agents/workflow.md` before inventing a route — it says where each kind of work starts
and what hands on to what.

### Issue tracker

GitHub Issues on this repository, via the `gh` CLI. `docs/agents/issue-tracker.md` carries the
operations, including wayfinding (`/wayfinder` falls back to local markdown without it).

### Labels

Thirteen, and the set is closed — `docs/agents/triage-labels.md`. Every issue carries exactly one
state and one category. The hub's Terraform owns the set, so a label added here by hand is deleted
by the next apply and one removed by hand comes back.

### Acceptance criteria

Before you stop: every criterion you satisfied is ticked on the issue, and every one you did not
is left unticked and carries a not-doing line in the pull-request body. Tick against the branch,
never against the effort. The drift block has a fixed shape —
`docs/agents/acceptance-criteria.md`.

### Domain docs

The glossary is `CONTEXT.md` and the decisions are `docs/adr/`, both at the root. Read them before
exploring an area, and `docs/agents/domain.md` before adding to either.

### Dependency updates

List the open Dependabot pull requests at both ends of any session that touches a pull request —
`docs/agents/dependencies.md`. Note its **first** merge condition: opting in means carrying
`dependabot-auto-merge.yml`, and this repository does not, so hand every bump to the Owner.

## Repository notes

**A sync is additive.** It writes and it skips, and a destination only ever grows — anything that
would remove, prune, or rename a file there is the decision argued in `docs/adr/0003`, and reading
that record is the first step of proposing it. The word is the glossary's: `CONTEXT.md` defines
*sync* as additive, and the code uses it too.

**`.data/chrome-profile` is the secret.** It is a live authenticated Chrome profile — possession
of it is possession of the student's NTULearn session. Leave it where it is, untracked and
`chmod 700`; a session belongs in that directory and nowhere else, least of all in a configuration
file or a log line. What it costs to hold a session this way is `docs/adr/0004`.

**`config/courses.json` is untracked too**, because it holds real course identifiers and a real
Drive path. `config/courses.example.json` is the tracked shape; change one and change the other,
along with the table in `README.md`.
