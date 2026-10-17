---
name: verify
description: Drive ntulearn's real CLI with isolated offline fixtures and retained evidence. Use to verify changes or follow its feature map; upstream commands still require the Owner.
---

# Verify ntulearn

Read [the feature index](features/README.md), then the affected feature. This skill drives the CLI; `npm run verify` is the separate, live course-presence audit.

## Launch

From the checkout root, use Node `^22.13.0 || >=24` and run exactly `npm ci --ignore-scripts`. No build, server, browser download, or media setup is needed. Ready means installation exits `0` and doctor passes.

Each CLI invocation gets a fresh OS temporary directory and an explicit `NTULEARN_CONFIG_PATH`. Never substitute the real configuration, profile, or Drive. The helper runs short processes serially; there is no shared app instance.

## Doctor

Run `node .agents/skills/verify/scripts/drive.mjs doctor`. It drives real `capabilities` and `check contracts`, requires schema version `1`, script/index parity, and passing repository contracts. Every journey runs doctor first and repeats it after an unexpected result before stopping. Expected refusals are assertions, not surprises.

After a doctor or harness failure, inspect its evidence. Correct skill drift within this directory and retry once with fresh evidence. Report product failures; do not weaken assertions. A stopped or timed-out child must settle before another drive.

## Drive

Use `node .agents/skills/verify/scripts/drive.mjs` followed by one journey:

| Journey | Proof |
| --- | --- |
| `cli` | Retained npm scripts/index parity, capability selections, removed command refusal, usage |
| `local` | Healthy and unsafe profile metadata; fresh, absent, stale, invalid, and failed local status |
| `session` | Missing-config refusals for login and discovery |
| `copy` | Missing-config refusals for sync, presence audit, and renumber |
| `watchdog` | Missing-config refusal for the scheduled run |

The last three prove the configuration boundary only. Report full journeys as `verified-unreachable`, with the attempted route and the feature's Owner/auth/Drive prerequisites. The Owner invokes actual live commands. Do not open Chrome, inspect session contents, or spend the saved session to improve coverage.

Run the repository's existing checks once when relevant: `npm run check -- --evidence .scratch/check-evidence-unique`. Replace `unique` with a fresh suffix. This preserves original failing invocation details; use them rather than adding another check framework. `check:syntax`, `check:contracts`, `test`, `lint`, and `format:check` are indexed alternatives. `format` writes repository files; reserve it for deliberate formatting work.

## Evidence

Each helper invocation prints its unique `.scratch/verify-*` directory. One JSON record per command retains the configuration override, stdout, stderr, exit code, signal/settlement, assertions, and before/after fixture modes and SHA-256 hashes. `run.json` states outcome and unreachable prerequisites. Synthetic filesystem inputs cross production boundaries; no internal setters or mocked NTULearn responses count as live proof.

Expected observations must match both exit code and structured result. A local pass leaves session validity and upstream completeness unrun. For Owner-run mutations, retain private before/after destination evidence and the real report; a refusal does not prove download, rename, or retry behavior.

## Cleanup

The helper removes only its temporary fixture directories, in `finally`, and confirms each saved evidence record exists after cleanup. Evidence stays in `.scratch/verify-*`, including failed attempts. Never clear shared state or kill processes by name.

The fixed command set uses short in-process offline routes and early configuration refusals. Each child has a 15-second limit and 2 MiB per output stream. Timeout or interruption kills that exact child, then waits for its close. Unconfirmed settlement preserves the fixture and stops further driving. Never add browser sessions or subprocess-spawning checks to this runner; use the existing check command for those.

## Helpers

`scripts/drive.mjs` is executable; the invocations above need only Node and installed repository dependencies. Keep the five feature files indexed as commands change. For a full source-and-drive upkeep pass, use the installed `maintain-verification-skill` skill against this directory; retain its per-feature coverage and unreachable reasons.
