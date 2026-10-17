# Local health and status

Users inspect local readiness and recent operational evidence without opening Chrome or claiming an upstream audit.

## Sub-features

- `health` observes Node, configuration, profile-directory permissions, Drive, and destination metadata.
- `status` summarizes valid sync receipts and the watchdog digest; stale or missing evidence blocks, failures fail.
- `privacy` keeps private paths, identifiers, raw logs, and profile contents out of structured reports.

## How to get to it (user POV)

- `npm run health`.
- `npm run status`.
- Both accept the production `NTULEARN_CONFIG_PATH` environment override, resolved from the checkout root for relative paths.

## Driving it with drive.mjs

Preconditions: supported Node; the helper creates its own configuration, `0700` profile directory, Drive/course folders, `Sync status.json`, and `latest.json`.

- **Ready.** Run `node .agents/skills/verify/scripts/drive.mjs local`. Synthetic healthy metadata and fresh complete receipt/green digest return `passed`, exit `0`; session validity stays `unrun`.
- **Missing configuration.** Health and status each return `blocked`, exit `2`, `CONFIG_UNAVAILABLE`, without creating files.
- **Unsafe profile.** A synthetic `0755` profile returns failed health, exit `1`; no browser opens.
- **Stale evidence.** Separate old receipt and old digest cases return blocked status, exit `2`; the summary identifies the stale observation.
- **Absent or invalid receipt.** Missing receipt returns `2`; an extra schema field returns `1`. Failed receipt and red digest independently return `1`.
- **Proof.** Every real CLI invocation gets a separate fixture. Compare its before/after modes and file hashes; all must match. Assertions also check that synthetic private paths and identifiers do not leak.

## Gotchas

- Fresh means at most 48 hours old. Future or noncanonical timestamps are invalid.
- A receipt has schema version `1`, producer `ntulearn`, lifecycle timestamps, counts, and sorted `unread`; exact root fields matter. Fixtures use only production JSON files.
- Healthy local files do not establish sign-in validity, file-byte fidelity, or upstream completeness.
- Sources: [health](../../../../src/capabilities/health.mjs), [status](../../../../src/capabilities/status.mjs), [receipt](../../../../src/sync/import-status.mjs), [result/exit codes](../../../../src/capabilities/result.mjs).
