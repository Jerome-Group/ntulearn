# Source editions add distinct identities and announcement revisions

A sync may claim new, exclusive source names for distinct attachments that collide and new rendered
revisions of announcements. It never overwrites, renames or prunes an original or an edition. This
narrowly supersedes ADR-0016's prohibition on automatic rescue names for these two cases only;
its prohibitions for differing attachments of one identity, pages, overviews and stand-ins remain.

Refusal alone retained every old byte but made two legitimate attachments with the same filename
unavailable, and left an announcement's revised wording unavailable whenever its earlier copy or
annotations occupied the name. An empty identity/revision name delivers the new source without
pretending that an occupied file is disposable. Numbering and a generated marker cannot provide
that permission. They do not distinguish a source, and they do not establish present ownership.

An exclusive, checksum-named provenance record in the course destination establishes the source's
positive identity, accepted digest and placement. Sync compares current file bytes before reusing
a recorded source; edited editions remain conflicts rather than receiving another rescue name.
Legacy unsuffixed files without positive evidence stay unproven. A stable identity collision name
can bring new sources alongside them without assigning their ownership. State remains disposable;
a matching legacy fingerprint, safe recorded path and current checksum can establish a placement,
but a name, size or marker cannot.

For these identities only, this narrows ADR-0005's placement lookup: verify may read bounded local
source-placement provenance, never State, before asking whether the resolved file is present. It
still does not validate the present source's bytes, freshness, fidelity or exhaustive visibility.
The shared source resolver prevents one ambiguous pathname from crediting distinct sources twice.

## Consequences

- An announcement edition links its retained original placement when one exists and its upstream course.
  An initial collision reports that no original was recorded instead of inventing a link.
  A digest identifies rendered wording, not an acoustic or semantic quality claim.
- Same-source edited originals and editions remain untouched. Identical repeats claim no new
  edition. An occupied different deterministic suffix remains an actionable publication conflict.
- Provenance is additive too. Malformed, ambiguous or over-limit records require inspection;
  metadata is not replaced in an attempt to conceal the ambiguity.
- Exclusive publication can leave a source without its record after interruption. The next run
  can accept identical fetched bytes; it cannot infer identity merely from the abandoned name.
- Receipt counts distinguish editions, reuse, unresolved identity and publication conflicts.
  Drive boundaries and all other occupied-file protections remain unchanged.

## Revisit when

A source lacks a stable positive identity, or the Owner requests replacing an occupied canonical
source. Neither is permission to infer identity or expand this exception silently.
