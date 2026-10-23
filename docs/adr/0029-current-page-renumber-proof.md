# Current recorded page revisions use their accepted bytes for renumber proof

The timing and concurrency interpretation of renumber proof is clarified by
[ADR-0031](0031-renumber-claims-preserve-concurrent-edits.md). Current rendered revision and complete
accepted digest and length remain required. Proof checks the captured inode and does not lock future writes.

For positively recorded current content-item pages, renumber proves the current rendered-source
revision and the complete accepted file digest and byte count. This narrowly supersedes
[ADR-0010](0010-renumbering-is-its-own-command-and-renames-only-what-it-can-prove.md)'s literal walk-text proof for these pages, which
[ADR-0027](0027-source-revisions-preserve-occupied-originals.md) permits as immutable revisions.
Ordinary documents retain exact walk-text proof. Attachment permission still requires State;
losing State still prevents attachment renumbering.

A page edition's accepted bytes include its retained-original footer. After a parent rename,
regenerating that relative link can change the footer while the rendered source remains the same.
Calling those accepted bytes edited rejects an unchanged current edition and breaks repeat sync.
The walk's rendered-source digest identifies the current revision. Its provenance digest proves
the complete bytes on disk remain unchanged. Neither proof substitutes for the other.

Sync hashes and checks the length of one Buffer, then reuses that same Buffer's text. It keeps
the existing exclusive writer and publication evidence checks, so a later mutation still refuses.
Renumber writes neither State nor provenance. It changes only the numeric prefix inside the
file's actual parent, leaving originals and historical editions intact.

## Consequences

Accepted footer links can become stale after a parent rename. Preserving immutable bytes takes
precedence over repairing those links. Edited current pages and ambiguous or contradictory
source evidence remain refusals. A missing recorded placement permits only one safe numeric
fallback, including when equivalent stale records describe the same accepted placement.

## Revisit when

The Owner requests a procedure to repair retained-original links or replace accepted page bytes.
