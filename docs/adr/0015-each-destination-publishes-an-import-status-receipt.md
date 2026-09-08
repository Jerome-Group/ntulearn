# Each destination publishes an import-status receipt

Partially supersedes ADR-0008: the Markdown stamp retains its meaning and counts, while the
destination gains separate durable health evidence.

Every course sync atomically publishes `Sync status.json` in that course's destination. It writes
`running` before reading the course, then `complete`, `partial`, or `failed` at the terminal boundary.
Only a complete attempt advances the retained last-success time. A process interrupted between those
writes leaves durable running evidence.

The receipt answers a question `Last synced.md` deliberately cannot: whether the latest observed
attempt completed cleanly. The stamp stays human-readable and keeps meaning “the walk completed at
this time,” including a partial walk. The receipt is the stable machine interface Academic OS reads;
private State and watchdog logs stay implementation records, and stdout remains the detailed report
of one invocation.

The shared versioned shape is owned by Academic OS at
[`docs/import-status-contract.md`](https://github.com/Jerome-Group/academic-os/blob/main/docs/import-status-contract.md).
This repository validates every prior and generated receipt against that closed interface and carries
the same synthetic fixture. A malformed, unsupported, oversized, or future-dated prior receipt
preserves no claimed success. An unreadable prior receipt does the same: the attempt continues from
`null`, while inability to publish the fresh atomic `running` receipt still stops it before reading
the course. No historical read error is copied into the receipt.

## Boundaries

- The receipt carries lifecycle timestamps, bounded counts, and unread optional categories. It
  carries no course identifier, path, URL, source text, or raw exception.
- It describes the sync only. Media discovery and acquisition retain their separate status.
- It is diagnostic evidence, not proof of exhaustive upstream visibility or current file bytes. It
  grants no permission to withdraw a source, overwrite curated work, or skip a full curation walk.
- Each publication is atomic. The interface does not serialize overlapping manual and scheduled
  syncs. Each attempt preserves the success it saw at startup, so an older overlapping attempt may
  later regress that value to an older time or `null`; a reader treats the receipt as a last-writer
  observation and rereads when freshness matters.
- A terminal publication failure makes the attempt fail. If writing `failed` also fails after a
  course error, the original course error remains the one the caller receives.

## Rollout

NTULearn and Academic OS deploy independently. Existing destinations gain a receipt on their next
sync; until then Academic OS reports one missing. Older Academic OS versions treat the file as
importer-owned material inside the open root. Installation performs no migration, sync, scheduler
change, or module-control rewrite.

## Consequences

- A destination has two operational files: the Markdown stamp for a person and the JSON receipt for
  a machine. Neither contributes to document or attachment counts.
- Failed and interrupted reads become visible without exposing private State or parsing prose.
- The receipt adds one small Drive write at attempt start and one at its terminal boundary.
