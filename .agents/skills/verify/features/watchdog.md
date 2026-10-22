# Watchdog

The Owner runs the guarded scheduled copy and audit, then reads its verdict and retained run evidence.

## Sub-features

- `readiness` checks the Drive mount, destination containment and each destination's first Drive root before attempting work.
- `lock` avoids overlapping scheduled runs.
- `run` copies and audits with bounded attempts. The watchdog returns its own locked child's digest after publication and validates the reply against its exit status.
- `verdict` distinguishes green success, yellow skipped lock, and red destination/session/run failures.

## How to get to it (user POV)

- Owner runs `npm run watchdog` or configures that same command in their scheduler.
- Owner reads the configured state's `latest.json` and private logs; `npm run status` gives a bounded offline digest view.

## Driving it with drive.mjs

Preconditions: offline boundary proof needs no session. A full run needs Owner invocation, private configuration, authenticated Chrome, mounted Drive with accessible destinations, available watchdog lock, and time for retries.

- **Attempt the real route.** Run `node .agents/skills/verify/scripts/drive.mjs watchdog`. It invokes `node src/cli.mjs watchdog` with an absent temporary configuration.
- **Refusal proof.** Exit `1` names the configuration-copy action. Before/after fixture snapshots are empty; no lock, digest, logs, destination, or profile is created.
- **Digest observation.** Run `node .agents/skills/verify/scripts/drive.mjs local` once across the maintenance pass. Its real status route observes synthetic green, stale, and red digests. This proves the reader, not the watchdog producer.
- **Full journey.** Record `verified-unreachable` with the attempted watchdog route and prerequisites above. An Owner-run report, private run log, and before/after destination evidence are needed to prove scheduling, locking, retry, and copy behavior.

## Gotchas

- A yellow skipped lock is not a new successful copy. A green prior digest may be stale.
- A missing, invalid, oversized, signalled, or contradictory child reply fails with an action to inspect this run's stderr or the launchd stderr log. Existing publications remain intact.
- `latest.json` and offline `status` describe the last published digest. They cannot expose a failed attempt that never published.
- Do not invoke internal `watchdog-locked`, acquire shared locks, clear state, or retry live work through this helper.
- Private operational logs can contain course paths and stderr. Keep them local; never attach their raw contents to public issues or this map.
- Sources: [runner](../../../../src/watchdog/run.mjs), [verdict](../../../../src/watchdog/verdict.mjs), [offline reader](../../../../src/capabilities/status.mjs), [CLI](../../../../src/cli.mjs).
