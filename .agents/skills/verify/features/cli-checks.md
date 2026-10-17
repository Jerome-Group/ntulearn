# CLI and repository checks

Users discover supported commands, select machine-readable capabilities, and run local checks with optional retained failure details.

## Sub-features

- `index` lists all sixteen npm scripts with effects, prerequisites, source routes, and versioned output contracts.
- `selection` accepts a command ID or feature; an unknown selection returns structured exit `2`.
- `checks` runs `all`, `syntax`, `contracts`, `format`, `lint`, or `test`; unselected checks remain `unrun`.
- `tools` exposes native test, lint, and formatter scripts. `format` writes files.

## How to get to it (user POV)

- `npm run capabilities` or `npm run capabilities -- authentication`.
- `npm run check`, `npm run check:syntax`, `npm run check:contracts`.
- `npm test`, `npm run lint`, `npm run format:check`, `npm run format`.
- `npm run check -- --evidence .scratch/check-evidence-unique`, using a fresh suffix.

## Driving it with drive.mjs

Preconditions: supported Node and installed dependencies; no student configuration required.

- **Index and selection.** Run `node .agents/skills/verify/scripts/drive.mjs cli`. It observes script/index parity, exact retained scripts, the selected `health`, `authentication`, and `check:contracts` routes, and unknown/retired selections.
- **Actual checks.** Doctor invokes `node src/cli.mjs check contracts` and requires passing contract observations. Run `npm run check -- --evidence .scratch/check-evidence-unique` once for broader validation, then inspect the original check evidence if it fails.
- **Usage.** The helper attempts unexpected health arguments and an unknown check selection; each must return version `1`, status `blocked`, exit `2`.
- **Proof.** Inspect invocation, stdout/stderr, assertions, unchanged fixture hashes, and cleanup in the printed evidence directory. `format:check` proves formatting without rewriting the checkout.

## Gotchas

- `npm run` adds banners; use `npm run --silent` when parsing JSON. The helper calls the same `src/cli.mjs` entry directly.
- A failed check's bounded summary is not its diagnostic transcript. Preserve `--evidence` output; never overwrite an earlier evidence directory.
- Run `format` only when intentionally changing tracked code. Review its diff and run `format:check`; it is not a read-only verification step.
- Sources: [CLI](../../../../src/cli.mjs), [index](../../../../src/capabilities/index.mjs), [checks](../../../../src/capabilities/check.mjs), [contracts](../../../../src/capabilities/contracts.mjs), [scripts](../../../../package.json).
