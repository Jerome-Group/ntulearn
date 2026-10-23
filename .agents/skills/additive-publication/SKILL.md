---
name: additive-publication
description: Check occupied-file preservation and complete publication after changes to writeWithoutReplacing, its occupancy helpers, or writeAtomically. Run the bounded model and native source probes; review mapping drift before updating coverage.
---

# Check additive publication

An occupied course path keeps its first occupant's kind, identity, and bytes. A successful publication contains the complete requested bytes. Breaking either promise can destroy a student's annotation or accept a truncated course file. [ADR-0003](../../../../docs/adr/0003-a-sync-never-deletes-from-a-destination.md) and [ADR-0016](../../../../docs/adr/0016-occupied-course-files-require-manual-conflict-resolution.md) establish the preservation requirement.

## Run the check

From the checkout root, use Node `^22.13.0 || >=24` and Java 11 or later. Install the pinned TLC tools distribution once with network access.

```sh
npm ci --ignore-scripts
node .agents/skills/additive-publication/scripts/setup.mjs
node .agents/skills/additive-publication/scripts/check.mjs
```

`JAVA` selects a Java executable. `TLA2TOOLS_JAR` selects an existing jar. The default jar is `.scratch/formal-tools/tla2tools.jar`. Every run verifies SHA-256 `936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88`. Distribution 1.7.4 contains TLC 2.19 of 08 August 2024. The check uses one worker, fingerprint polynomial 0, and seed 1. Setup needs the network; checking an installed jar does not.

Require `PASSED` and a retained `run.json` with `outcome` equal to `passed`. Inspect the printed `.scratch/formal-additive-*` directory. It holds source hashes, original source snapshots, import-only instrumentation diffs, tool invocation and version, complete TLC output, actual bytes and hashes, outcomes, syscall paths, and partial-file readback. Each native probe gets a separate temporary fixture. Cleanup follows the exact child's `close` event. An unsettled child preserves its fixture and fails the check.

To prove that the checks still detect the guarded mistakes, run this command.

```sh
node .agents/skills/additive-publication/scripts/check.mjs --self-test
```

Require both named model counterexamples and both predicted source byte mismatches. The replacement mutant makes B replace A's complete body. The truncation mutant returns `true` after publishing A's body without its final newline. Import errors, timeouts, and generic failures do not count. The command removes scratch source mirrors and finishes with pristine model and native reruns. Production files remain intact.

## Review source correspondence

The confirmed source commit is `705727602b72866c188cef7b83a66f5bc919708b`. [coverage.json](coverage.json) records that commit and fingerprints the covered functions and imports. Whole-file hashes are evidence, not coverage claims. Changes to unrelated functions in `files.mjs`, including `relinkFile`, do not establish publication coverage.

| Model action | Covered production function | Boundary |
| --- | --- | --- |
| `Inspect`, `Reinspect` | `identicalOrAbsent` in `src/sync/files.mjs` | One `lstat` await each. |
| `Read`, `Reread` | `identicalOrAbsent` | A separate `readFile` await after each regular-file observation. |
| `Stage` | `writeWithoutReplacing` calls `writeAtomically` in `src/atomic.mjs` | Private directory creation, complete write, and private rename collapse under unique names and stable parents. |
| `Claim` | `writeWithoutReplacing` | Exclusive `link(partial, path)`, or EEXIST before reinspection. |
| `Cleanup` | `writeWithoutReplacing` | Unlink only this writer's private partial. |
| Conflict and absent outcomes | `destinationConflict`, `missingAsNull` | Only ENOENT means absent; differing bytes and nonfiles conflict. |

The native probes copy actual source bodies unchanged and redirect only filesystem imports. `scripts/native-fs.mjs` owns filesystem path classification and the operation allowlist. Destination-targeting `rename` and `link` share the publication gate. Unknown imports, covered-function changes, or unmapped operations fail pending review. Both race participants observe absence before either publishes; A publishes before B attempts its claim. Different bodies require `true`, `SYNC_FILE_CONFLICT`, and A's bytes. Equal bodies require `true` then `false`. Fresh, identical occupied, differing occupied, directory, and symlink scenarios check their observed outcomes and preserved occupants. These probes are deterministic witnesses on a native filesystem, not exhaustive JavaScript or OS scheduling proofs.

## Keep the proof in sync

After covered source changes, use `maintain-formal-verification-skill` and read every covered-source diff and commit message since the confirmed commit. Classify each change as no effect, mapping drift, intended promise change, or possible product bug. Update actions from the source before rerunning. Advance the confirmed commit in this skill and `coverage.json` only after reviewing correspondence, regenerating the named-function fingerprints, and rerunning `--self-test` cold. Review new writers of the shared path separately.

For a failure, inspect the retained trace and replay its source steps. An impossible source step means model or harness drift. A reachable violating step means a product finding. Keep the finding, invariant, and bounds intact; report the introducing commit and the student's risk. Tool absence is blocked verification. Make product fixes separately. Do not run student data commands to improve this proof.

## Bound the claim

`Publication.tla` exhausts three cooperative writers, one destination, all eight assignments of bodies A and B, and five initial occupants. Initial occupants are absent, regular A, regular Existing, directory, and symlink. `firstOccupant` starts with the initial occupant and is set once on the first claim. `FirstOccupantPreserved` checks kind, identity, and bytes in every reachable state. `SuccessfulBytesComplete` checks requested bytes separately from staged and accepted bytes. Every `lstat` and subsequent read remains a separate action. Terminal stuttering permits completion; no fairness or liveness property is claimed.

Assume unique staging names, stable parents, normal completion, and native exclusive hard links with EEXIST. Exclude renumber, external writers or path swaps, inode aliases, parent replacement, crashes, durability, disk failures, UUID collisions, unsupported hard links, operational replacement publications, authentication, and live course reads. `writeAtomically` is covered only as private staging for `writeWithoutReplacing`. Its other callers are outside this proof. A bounded hand model does not verify arbitrary JavaScript. See the [research record](../../../../docs/research/additive-publication-formal-verification.md) for tool and skill sources.
