# Incomplete source recovery pins absence and current ownership

Explicit source recovery may select `state-owned-unformatted` per recording when metadata and the
expected formatted derivative are both absent. A unique recognized enabled-course queue claim,
recording-state identity, raw-source SHA-256/path and current owned retained media must agree. The
manifest pins the exact state and current logical queue digests. Existing completed-source recovery
keeps its metadata/original derivative requirements; absence is never a fallback from edited,
malformed or contradictory evidence.

A valid owned raw source can need a new recognition attempt before any derivative or metadata has
been written. Requiring an existing derivative excludes that case; manufacturing ownership metadata
or formatting suspect text merely to satisfy admission would obscure its incomplete state. Explicit
absence evidence allows a separately validated candidate while retaining the incomplete originals.
[ADR-0017](0017-transcript-formatting-preserves-source-wording.md)'s wording boundary and
[ADR-0020](0020-production-transcript-paragraphs-require-source-review.md)'s terminal review policy stand.

## Consequences

Both absence paths must have existing canonical immediate parent directories. Their identities are
pinned and checked under the existing exclusive queue lock before/after execution and around each
exclusive publication. Occupied files, dangling links, changed parents, changed source/media/state
or queue digests and competing claims refuse. Bounded checks followed by publication cannot provide
atomic compare-and-swap against every concurrent external editor; independent edits are preserved.

Runtime/reserve/budget checks, strict native source validation, independent-context ASR policy and
owned cleanup barriers remain mandatory. Failed or flagged candidates stay retained and unpublished.
Eligible candidates publish fresh exclusive editions/source/provenance, with the original derivative
explicitly recorded as absent. Recovery never writes the expected original path, replaces a raw
source, edits status/queue readiness or clears review. No acoustic accuracy is established.

## Revisit when

A separate authorized procedure can establish ownership for occupied derivatives or safely update
canonical readiness. This admission variant provides neither permission nor evidence for that work.
