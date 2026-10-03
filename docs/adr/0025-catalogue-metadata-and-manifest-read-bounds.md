# Catalogue metadata and manifest read bounds

A multi-course catalogue aggregates individually safe paths, titles, provenance and index links.
Applying one native transcript's address-count bound to that aggregate allowed planning but refused
the plan's own reader before publication. Native transcript safety remains unchanged. Catalogue JSON
uses bounded aggregate metadata validation, scanning every decoded key/value through the existing
address guard. Original tokens remain checked before overwritten duplicate-key evidence disappears;
finite numbers, raw value count/depth, UTF-8, aggregate bytes and per-string bytes are bounded. Both
proposed plan and producer receipt must pass their read-side contract before either is written.

The per-operation read budget remains 256 MiB/120 s. Repeatedly rereading a large immutable plan
before every small publication write exhausted that budget after partial synthetic publication.
Plan and receipt now receive descriptor-bound identities coupled to their admission hashes, with
full hashes again at initial/final publication and identity checks between every write. Private
profile exclusions are rechecked before those probes. Device/inode/size/mtime/ctime changes, byte
changes, replacement and aliases refuse. This does not establish universal external-edit exclusion
or atomic filesystem cancellation. Existing snapshot, ownership, reserve, journal, beforeimage and
managed index checks remain; bounded failures expose fixed codes/counts while retaining evidence.

Catalogue metadata accepts at most 16 MiB, 100,000 raw/decoded values, depth 16 and 1 MiB per string,
with the existing per-string address guard additionally applicable. Generated plans retain their
stricter 4 MiB write bound. These are aggregate metadata limits, never permission to relax transcript
or candidate quality gates. Offline multi-course plan/publish/verify/repeat and mutation/unsafe
proposal regressions qualify the contracts; actual publication remains a separate Owner phase.
