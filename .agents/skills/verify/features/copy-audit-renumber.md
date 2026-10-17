# Course copy, audit, and renumber

The Owner copies visible course pages, announcements, and attachments, audits expected presence, or deliberately restores numbering on proven files.

## Sub-features

- `sync` writes missing content, preserves occupied or edited files, and records state and sync receipts.
- Colliding distinct attachment identities and changed attachment, page, or announcement revisions add immutable sibling files with source identity or revision suffixes. Originals and annotations stay. `Source editions` holds their provenance; reports and receipts expose `newEditions`, `reusedFiles`, `unresolvedIdentity`, and `publicationConflicts`.
- `verify` reports presence, missing paths, moved numbering, unread categories, and refused courses without writing either side.
- `renumber` moves only proven unchanged paths within their existing folders; occupied targets and unproven files remain.

## How to get to it (user POV)

- Owner runs `npm run sync -- all`, `npm run verify -- all`, or `npm run renumber -- all`.
- Each also accepts a configured course key, matched case-insensitively.
- After an authorized sync, read its report and receipt, inspect added sibling files, and read provenance under `Source editions` inside that destination.

## Driving it with drive.mjs

Preconditions: offline boundary proof needs no course content. Full journeys need Owner invocation, authenticated Chrome, private configuration, mounted Drive, distinct accessible course destinations, and a separate Owner decision to rename for `renumber`.

- **Attempt the real routes.** Run `node .agents/skills/verify/scripts/drive.mjs copy`. It invokes `sync all`, `verify all`, and `renumber all` through `src/cli.mjs`, each with an absent temporary configuration.
- **Refusal proof.** Each exits `1` with the configuration-copy action; empty fixture snapshots match and no session, state, or destination is created.
- **Full copy/audit.** Record `verified-unreachable`. After the Owner invokes actual sync, its report, private destination before/after evidence, and receipt establish writes/skips; an Owner-invoked audit establishes expected presence relative to that course walk.
- **Full source editions.** Record `verified-unreachable`. An Owner-run sync over distinct identities or changed source revisions must preserve original hashes, publish exclusive editions, report the counters above, and reuse matching editions on repeat. Missing or ambiguous identity and occupied publication paths remain explicit failures. The audit checks presence and accepted placement metadata; it does not fetch or prove current source bytes.
- **Full renumber.** Record `verified-unreachable` with the additional rename decision. Owner-run before/after names and hashes must show only eligible moves, intact bytes, and retained edited/occupied files. Do not credit the refusal as this proof.

## Gotchas

- Sync is additive; never remove, prune, or rename a student's destination as cleanup.
- Presence audit is not byte fidelity or exhaustive upstream completeness. A stale receipt is not a substitute for an audit.
- Renumber can break links and changes Drive paths. It never belongs in a sync or an automated verification run.
- Sources: [CLI](../../../../src/cli.mjs), [sync](../../../../src/sync/course.mjs), [audit](../../../../src/sync/verify.mjs), [renumber](../../../../src/sync/renumber.mjs), [state](../../../../src/sync/state.mjs), [source editions](../../../../src/sync/source-editions.mjs).
