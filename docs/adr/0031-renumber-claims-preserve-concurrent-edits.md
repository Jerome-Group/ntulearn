# Renumber claims preserve concurrent edits and refuse folder moves

Renumber captures a file into a fresh private sibling directory before proving the exact captured
regular inode and publishing it with an exclusive hard link. Only private names are unlinked.
Every failed capture is retained for explicit Owner recovery, even if an exclusive link restores
the old empty name. Existing claims gate new work through bounded, read-only discovery. Folder
moves refuse because portable Node cannot publish a directory rename without replacing an
occupied empty directory.

This supersedes [ADR-0010](0010-renumbering-is-its-own-command-and-renames-only-what-it-can-prove.md)'s public link-then-unlink protocol, no-temporary-name rationale,
unconditional old-path-on-refusal promise, directory movement, and interpretation of unchanged-byte
proof as excluding concurrent edits. Its separate opt-in command, same-parent scope, path-link
cost, and read-only State remain. [ADR-0029](0029-current-page-renumber-proof.md)'s current rendered
revision plus complete accepted digest and byte count remain required. Its proof is now checked against the captured inode, and cannot
promise that no writer changes the inode afterward.

## Why the source must be claimed first

Issue #324 reproduced a data loss schedule with native filesystem calls. The old helper linked
sync inode A at the new name. An editor then atomically replaced the public source with student
inode B. Unlinking that source deleted B's sole name and reported success. Another stat check or an
advisory lock an editor ignores leaves the same race. No permission observation makes a later
public pathname unlink belong to the observed inode.

A fresh `.ntulearn-renumber-<id>` directory has mode `0700` and a bounded `0600` intent manifest
written completely before capture. The manifest records schema version, id, sibling basenames,
and the permission proof. Atomic rename into its absent `payload` name removes the source name
without unlinking whatever an editor creates there afterward. The private payload is opened with
`O_NOFOLLOW | O_NONBLOCK`, required to be a regular file of the permission byte count, and hashed
through that one handle with reads bounded to the permission byte count plus one. Growth or truncation refuses rather
than extending the observation indefinitely. A symlink or FIFO neither grants permission nor
blocks a read.

Exclusive hard-link publication refuses every occupied target kind. Successful publication keeps
the same inode, including writes through an open descriptor before or after publication. Proof is
an observation rather than a content lock. Publishing a separate copy of the proved Buffer would
change inode identity and require permanent retained copies for late writers, without freezing
future target writes. Those costs do not answer the demonstrated source-replacement defect.

## Recovery is retained rather than replayed

A completed intent precedes every capture, so a process exit leaves either the public source or a
recognizable private payload. On failure, a regular payload may be linked exclusively back to an
empty source name. An occupied source survives. The payload stays even after restoration because
an editor can replace that restored public link before any later cleanup. Nonfiles remain private
without automatic restoration. No failure path recursively removes a claim or renames onto a
public endpoint.

Each report names its absolute `claimPath`, publication certainty, restoration outcome, and next
action. The Owner inspects the claim and both public names, preserves the captured bytes, and
restores only to an empty name. Removing a claim requires verification that its bytes are safe.
There is no automatic recovery, capture replay, or garbage collection. A cleanup failure after
successful publication also retains the remaining recognizable state for inspection.

Discovery runs before the course read and again before each new capture. It reads at most 10,000
entries through 64 directory levels, inspects at most 128 claims, and reads at most 4 KiB of an
intent. It does not follow descendant symlinks, descend into claims, or open payloads. Retained,
malformed, incomplete, unreadable, and discovery-limit states stop new work. A second invocation
only reports that same state rather than recapturing a replacement public source.

## Consequences

The public old name can be temporarily absent. A refusal after capture can leave its bytes only
in the reported private claim, or at both the restored old name and the private name. This replaces
ADR-0010's unconditional old-name guarantee with an explicit recovery obligation. Ordinary success
leaves only the new public name and removes its own private payload, manifest, and empty directory.

Folder moves now appear under `blocked` with a manual next action. Files still change their numeric
prefix inside their actual existing parent, including when its folder number remains old. Portable
Node exposes no exclusive directory rename, so retaining `stat(to); rename(from,to)` would still
consume an empty directory created between those operations. Native addons, FFI, and platform
binaries do not become prerequisites to retain that feature.

Attachments continue to require compatible State identity and digest evidence. Recorded current
pages continue to require current source revision and complete accepted bytes. Ordinary documents
require walk bytes. State and provenance are read-only. A `kept` file remains ordinary; blocked
moves and recovery claims cause exit `1`.

The supported filesystem must permit same-filesystem hard links. Unsupported publication fails
closed with a retained claim. Process interruption is covered by completed namespace operations.
Power-loss durability, filesystem corruption, hostile ancestor or private-directory replacement,
and preservation of every intermediate version written through the same inode remain outside
the contract.

## Revisit when

The Owner needs explicit recovery tooling, a supported exclusive directory publication facility,
or a publication snapshot distinct from normal rename identity. Each needs its own evidence and
decision before expanding this protocol.
