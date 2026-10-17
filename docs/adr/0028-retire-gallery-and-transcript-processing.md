# Retire Gallery capture and transcript processing

Keep the additive course walk, its Markdown and original attachments. Remove the separate media
workflow, including content-tree player acquisition, lecture Media Gallery discovery and capture,
transcription, formatting, recovery, evaluation, catalogues and scheduled workers. External players
remain links; audio and video exposed as ordinary attachments still copy unchanged.

The Owner no longer wants lecture recordings or transcripts collected. Keeping a disabled worker
would retain its runtime, queue, configuration and verification burden. Removing that subsystem
makes the supported boundary explicit and leaves agents fewer paths to load and maintain.

This supersedes [ADR-0014](0014-recordings-use-a-separate-media-workflow.md),
[ADR-0017](0017-transcript-formatting-preserves-source-wording.md),
[ADR-0020](0020-production-transcript-paragraphs-require-source-review.md),
[ADR-0021](0021-incomplete-source-recovery-pins-absence-and-current-ownership.md),
[ADR-0022](0022-transcript-catalogues-separate-reading-from-media-readiness.md),
[ADR-0023](0023-gallery-announcement-close-retains-context-read-guard.md),
[ADR-0024](0024-optional-vad-recovery-keeps-full-recording-gates.md),
[ADR-0025](0025-catalogue-metadata-and-manifest-read-bounds.md) and
[ADR-0026](0026-unassociated-source-readings-never-infer-course-association.md).
Their historical reasoning stays recorded.

## Consequences

- Old `media` and `courses[].mediaMode` configuration is ignored. It cannot activate any workflow.
- Agent capabilities, local health and status describe the supported course sync and watchdog.
  `Sync status.json` keeps its existing schema and Academic OS contract.
- The project verify skill maps supported commands to source and evidence. Offline CLI drives
  supplement focused contract and regression checks. Authentication and real course drives remain
  Owner-only; offline success does not claim exhaustive upstream coverage.
- A one-time Owner-authorized retirement removes generated Gallery and transcript artifacts from
  course folders after an exact inventory and a verified recoverable copy outside Drive. Ordinary
  attachments and student work remain. Prepared runtime, model and working copies owned by the
  retired workflow move to recovery too; system-wide tools stay installed. Unknown provenance
  refuses removal.
  This is a separate retirement operation; [ADR-0003](0003-a-sync-never-deletes-from-a-destination.md)
  still prohibits deletion during sync.
- No live recording or transcript repair route remains. Restoring that behavior requires an
  explicit new decision rather than re-enabling a configuration field.

## Revisit when

The Owner requests a bounded recording use case with a verification and storage cost worth keeping.
