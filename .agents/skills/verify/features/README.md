# ntulearn verification map

Read this index before driving. Each recipe uses real CLI processes with fresh synthetic configuration and keeps evidence outside the disposable fixture. Doctor is the checkout readiness check; it does not authenticate a student.

| Feature | Public npm commands | Source entry points |
| --- | --- | --- |
| [CLI and checks](cli-checks.md) | `capabilities`, `check`, `check:syntax`, `check:contracts`, `test`, `lint`, `format`, `format:check` | `src/cli.mjs`, `src/capabilities/index.mjs`, `src/capabilities/check.mjs`, `package.json` |
| [Local health and status](local-health-status.md) | `health`, `status` | `src/capabilities/health.mjs`, `src/capabilities/status.mjs`, `src/sync/import-status.mjs` |
| [Offline library](offline-library.md) | `library` | `src/library/`, `src/cli.mjs`, `src/config.mjs` |
| [Session and discovery](session-discovery.md) | `login`, `discover` | `src/ntulearn/session.mjs`, `src/ntulearn/client.mjs`, `src/config.mjs` |
| [Copy, audit, renumber](copy-audit-renumber.md) | `sync`, `verify`, `renumber` | `src/sync/course.mjs`, `src/sync/verify.mjs`, `src/sync/renumber.mjs` |
| [Watchdog](watchdog.md) | `watchdog` | `src/watchdog/run.mjs`, `src/watchdog/verdict.mjs` |

Run from the checkout root after `npm ci --ignore-scripts`. All helper commands begin `node .agents/skills/verify/scripts/drive.mjs`. Each journey includes doctor; avoid rerunning all repository checks for every feature. Read `run.json`, assertions, and cleanup records before reporting coverage. Keep evidence local.

Retained public commands are the seventeen entries above. `watchdog-locked` is internal. Media commands are retired. A missing map entry needs a concrete source route before addition. Keep each feature's four H2 sections and update its user routes, prerequisites, and proof together.

For `session`, `copy`, and `watchdog`, the helper exercises only a missing-config refusal. Their full journeys remain `verified-unreachable` until the Owner invokes them with authenticated Chrome, private configuration, and required Drive destinations. Never credit that boundary proof as upstream coverage.
