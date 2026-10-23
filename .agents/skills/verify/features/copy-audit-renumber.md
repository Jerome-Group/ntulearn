# Course copy, audit, and renumber

The Owner copies visible course pages, announcements, and attachments, audits expected presence, or deliberately restores numbering on proven files.

## Sub-features

- `sync` writes missing content, preserves occupied or edited files, and records state and sync receipts.
- Attachment State is keyed by stable source identity, so distinct course items sharing one URL retain separate permissions. Modern keys take precedence; compatible legacy URL entries remain readable, while conflicting identities cannot lend ownership.
- Colliding distinct attachment identities and changed attachment, page, or announcement revisions add immutable sibling files with source identity or revision suffixes. Originals and annotations stay. `Source editions` holds their provenance; reports and receipts expose `newEditions`, `reusedFiles`, `unresolvedIdentity`, and `publicationConflicts`.
- `verify` reports presence, missing paths, moved numbering, unread categories, and refused courses without writing either side.
- `renumber` selects the current source edition, then changes only its numeric prefix inside its actual parent. Attachments still require compatible State digests. Recorded current pages require the rendered-source revision and complete accepted bytes, including their immutable footer. Originals, historical editions, edited files, and occupied targets remain. The same-inode claim protocol retains failed captures with actionable recovery paths, gates new work on read-only discovery, and refuses all folder moves.

## How to get to it (user POV)

- Owner runs `npm run sync -- all`, `npm run verify -- all`, or `npm run renumber -- all`.
- Each also accepts a configured course key, matched case-insensitively.
- For `blocked` folder moves, keep the folder name or rename it manually after checking both names. For `recoveries`, inspect each absolute `claimPath` and both public names, preserve the captured bytes, and restore only to an empty name. Remove a claim only after verifying recovery, then retry renumber.
- After an authorized sync, read its report and receipt, inspect added sibling files, and read provenance under `Source editions` inside that destination.

## Driving it with drive.mjs

Preconditions: offline boundary proof needs no course content. Full journeys need Owner invocation, authenticated Chrome, private configuration, mounted Drive, distinct accessible course destinations, and a separate Owner decision to rename for `renumber`.

- **Attempt the real routes.** Run `node .agents/skills/verify/scripts/drive.mjs copy`. It invokes `sync all`, `verify all`, and `renumber all` through `src/cli.mjs`, each with an absent temporary configuration.
- **Refusal proof.** Each exits `1` with the configuration-copy action; empty fixture snapshots match and no session, state, or destination is created.
- **Full copy/audit.** Record `verified-unreachable`. After the Owner invokes actual sync, its report, private destination before/after evidence, and receipt establish writes/skips; an Owner-invoked audit establishes expected presence relative to that course walk.
- **Full source editions.** Record `verified-unreachable`. An Owner-run sync over distinct identities or changed source revisions must preserve original hashes, publish exclusive editions, report the counters above, and reuse matching editions on repeat. Missing or ambiguous identity and occupied publication paths remain explicit failures. The audit checks presence and accepted placement metadata; it does not fetch or prove current source bytes.
- **Offline renumber regressions.** `node --test test/renumber-files.test.mjs test/renumber.test.mjs test/source-editions.test.mjs test/numbering.test.mjs test/cli.test.mjs` drives native isolated destinations and synthetic upstream clients through current attachment and page revisions, leaf moves, folder refusal, immediate audit, and repeat sync. It proves the original editor-replacement regression, same-inode descriptor edits, before-capture proof refusal, exclusive target and restoration contention, injected failures and process exits, retained bytes and bounded read-only recovery discovery. It also checks unchanged-byte permission, read-only State and provenance, State-loss refusal, unique numeric recovery, conflicting-source refusals, occupied targets, and publication refusal after a page mutation. CLI tests verify nonzero exits and actionable folder and recovery reports. These in-process clients do not establish live NTULearn coverage.
- **Full renumber.** Record `verified-unreachable` with the additional rename decision. Owner-run before/after names and hashes must show only eligible current-edition file moves inside their actual parents, explicit folder refusals, intact complete bytes, and retained edited or occupied files. Any failed capture must name its retained recovery directory and stop later moves; repeat discovery must neither replay capture nor delete recovery data. Snapshot State and provenance around renumber, audit immediately, then repeat sync to establish current-edition reuse without another course file. Include a later reorder after sync records the moved placement. Do not credit the refusal as this proof.

## Gotchas

- Sync is additive; never remove, prune, or rename a student's destination as cleanup.
- Presence audit is not byte fidelity or exhaustive upstream completeness. A stale receipt is not a substitute for an audit.
- Renumber can break links and changes Drive paths. It never belongs in a sync or an automated verification run.
- Folder renumbering refuses because portable Node has no exclusive directory rename. Recorded page footers remain byte-identical and may retain stale links from earlier parent renames. Malformed or conflicting provenance and multiple numeric fallback candidates require inspection.
- A public old name may briefly be absent while its exact inode is privately claimed. Captured bytes survive every failed move, including an attempted restoration; inspect both public names and the retained claim before manual recovery. Blocked folders and recovery claims make the CLI exit `1`.
- Recovery discovery refuses beyond 10,000 entries, 64 directory levels, 128 claims or 4 KiB per intent. Claims are never followed through symlinks or removed automatically. The proof does not freeze same-inode writers; hostile ancestor replacement and power-loss durability remain outside the contract.
- Sources: [file claims](../../../../src/sync/renumber-files.mjs), [attachment ownership](../../../../src/sync/attachment-state.mjs), [CLI](../../../../src/cli.mjs), [sync](../../../../src/sync/course.mjs), [audit](../../../../src/sync/verify.mjs), [renumber](../../../../src/sync/renumber.mjs), [state](../../../../src/sync/state.mjs), [source editions](../../../../src/sync/source-editions.mjs).
