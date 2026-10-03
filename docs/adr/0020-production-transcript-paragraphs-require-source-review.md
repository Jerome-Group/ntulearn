# Production transcript paragraphs require source review

Ordinary production derives deterministic paragraphs from source segments using `source-paragraphs-v1`.
It invokes no formatting model. Ordered words, case, numbers, operators, uncertain wording, supported
source speaker annotations and literal clock text remain unchanged. Native and normalized sources keep
segment timestamps; the derivative invents no timestamp, heading, speaker, punctuation or correction.
The existing lexical/native-safety guards remain mandatory. Input size and segment counts are bounded.

This partially supersedes [ADR-0014](0014-recordings-use-a-separate-media-workflow.md)'s model-based
production formatting choice. [ADR-0017](0017-transcript-formatting-preserves-source-wording.md)'s
source-preservation boundary stands. Explicit model evaluation, local ASR and fresh source recovery,
setup/install restrictions, pinned runtime checks, reserve checks and owned cleanup remain unchanged.

A separate model invocation per small chunk pays repeated startup/inference costs for presentation
changes that must preserve the same source words. Fluent output cannot repair recognition errors or
prove what was spoken. Deterministic paragraphs provide reproducible reading without that uncertainty;
synthetic costs and invocation counts do not establish production throughput or acoustic quality.

## Consequences

Empty sources, banner/payload text, control/encoding problems and suspicious repetition produce an
explicit source-review state. Native/source/media inputs stay retained, formatted readiness remains
incomplete, and retryability is false. Flags are review evidence with possible false positives, never
permission to delete, correct or silently re-transcribe. Native-only sources with no valid canonical
normalization remain visibly distinct from valid raw sources. Existing derivatives and user edits
remain protected even when their source needs review. A queue-only update cannot clear or rearm review.
An independently validated fresh-ASR candidate can be published separately through explicit recovery;
its original source is retained rather than automatically promoted or replaced.

## Revisit when

An independently checked, explicitly authorized source correction procedure provides stronger evidence.
Removing now-unused production formatter assets or weakening runtime/setup checks requires a separate
change; this decision does not install, remove or relax them.
