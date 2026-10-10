# Source revisions preserve occupied originals

Sync may add an immutable edition when a stable attachment identity yields different fetched bytes,
or a stable content-item identity yields different rendered page text. This narrows ADR-0016's
occupied-file refusal and ADR-0019's exclusion of revisions for these two source kinds. Their bans
on replacement, renaming and pruning still apply to every original and edition. Course overviews,
stand-ins and sources without positive identity retain the earlier refusal rule.

An attachment revision is the SHA-256 of fetched bytes. Its provenance binds that digest to the
current upstream fingerprint and the accepted path. A changed fingerprint prompts a download;
the fingerprint alone never supplies revision bytes. An unchanged fingerprint can reuse a recorded
edition only after its file digest still matches. The upstream may change bytes without changing
the fingerprint; that remains outside what a skipped download can detect. A revised page uses the
digest of its rendered source text. Both kinds keep the first placement and any student annotations.
Page and announcement Markdown editions link their retained original when one is known; binary
attachment editions record that association in provenance.
Where an attachment has no provenance or State, a retained earlier-number file remains unproven.
Sync fetches the current source and accepts identical bytes there or writes different bytes to a
new digest edition. It does not assign ownership to the retained original.

Legacy attachment provenance records no revision fingerprint. A matching State fingerprint and
current file digest may add a new association without downloading. State loss or a changed
fingerprint requires a revision probe. Publication fetches again and refuses if its digest differs
from the probe or a recorded current revision, before writing any course file. Verify downloads
nothing, so it reports an attachment with only
legacy provenance as missing until sync establishes the current association. It reads current
upstream metadata and local provenance to select an edition, then checks presence. It does not
verify current file bytes or source fidelity. An edited current edition remains a sync conflict;
an older edited edition does not prevent a distinct, positively identified upstream revision.
Legacy pages without provenance may still count as present at an occupied placement before sync.
That presence does not establish which rendered revision the file contains. After sync records a
page revision, verify selects its current edition and no longer credits the retained earlier one.
An attachment with no provenance has the same legacy presence limit until sync records its revision.

The rejected alternative was naming editions from metadata alone. Metadata can change while bytes
stay equal, or stay equal while bytes change. That would give duplicate or false current editions.
The fetched digest names the revision, while the fingerprint lets verify select it without fetching.

## Consequences

- Earlier originals and annotations remain available for comparison. No automatic replacement occurs.
- A lost State file costs a fetch for legacy attachments, but does not lose revision placement after
  current provenance exists.
- Malformed or conflicting provenance, edited current editions and ambiguous identities remain
  actionable refusals. Verify can establish presence, not byte integrity or complete upstream scope.

## Revisit when

NTULearn exposes a stronger upstream content version that verify can read without downloading, or
the Owner asks for a separate replacement procedure.
