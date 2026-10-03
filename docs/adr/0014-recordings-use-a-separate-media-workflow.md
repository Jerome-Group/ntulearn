# Recordings use a separate media workflow

[ADR-0017](0017-transcript-formatting-preserves-source-wording.md) partially supersedes the
formatting allowance for error correction and notation conversion; the separate workflow,
source preservation, local models and storage decisions remain unchanged.
[ADR-0020](0020-production-transcript-paragraphs-require-source-review.md) partially supersedes
model-based production formatting and adds retained source-review states; local ASR, explicit model
evaluation, setup restrictions, source preservation and the separate workflow remain unchanged.

`sync` stays the bounded additive walk it is. A separate media workflow discovers *recordings*
through that same course walk and through each course's *Media Gallery*, then acquires media and
transcripts through provider adapters. It keeps its own reconstructible queue and verdict: a green
sync does not claim recording completeness, and a recording missing either its source transcript
or its formatted transcript after the next overnight window stays red.

Gallery discovery exhausts its pagination and reconciles the recordings found against the count
the gallery displays. A mismatch leaves discovery incomplete and red rather than producing a
queue that quietly omits recordings.

One appearance is one recording, even when two appearances resolve to the same provider entry.
Acquisition work may be reused when the bytes agree, but every appearance remains independently
readable. Course scope is explicit rather than inferred from names or dates: each configured course
has a *media mode* of `active` for production, `pilot` for the agreed Y1S2/Y2S1 corpus, or `off`.

Storage follows the surface where the recording appeared. Media already exposed in the course
content tree stays beside that item in its *destination*, whether it arrived as an *attachment* or
through a player. Media Gallery video and audio live in the configured RAID0 *Media store*; its
formatted transcript and status remain visible under the course destination's `Media Gallery/`.
Provider-native transcript files, normalized timestamped transcripts, transcription working files,
models and caches live in the Media store for every recording. The workflow never falls back to
the system disk when RAID0 is absent.

The normalized source is `transcript.raw.json`: its language and ordered `{ start, end, text }`
segments are the interchange format for models and agents. Media Gallery paths use provider
creation date and time followed by title, preserve gallery order, and add a collision number only
where both still agree.

A content-tree player keeps its existing numbered link document and gains video and formatted
transcript siblings; an attachment already supplies the video sibling. A course-level media status
document and each formatted transcript state the provider, source kind, video and audio
availability, transcript provenance and any limitation in plain language.

A provider transcript is the source when it parses, carries meaningful text, has valid ordered
timestamps where supplied, and covers the recording's speech-bearing regions. Otherwise
transcription runs locally. Transcript formatting is local too; no lecture or transcript content
leaves the machine. The source is preserved unchanged; a separate Markdown derivative fixes only
non-semantic errors and carries no timestamps.
It preserves code-switching, never translates or summarizes, converts only unambiguous notation
while keeping the source wording nearby, and adds headings only for explicit lecture transitions.
Its metadata records the source SHA-256 and formatter version so *state* can be discarded and
freshness reconstructed. Routine runs never revisit a successful source or formatted transcript.
Explicit regeneration may replace only a derivative the workflow can prove it wrote. A recording
with no intelligible speech gets an explicit non-speech transcript rather than invented words.

Provider retrieval precedes capture: provider transcript, authenticated media or audio, then
student-visible browser playback. Ordinary manifests, segments, player-supplied keys and expiring
session tokens are in bounds; defeating enrollment, exploiting a service or extracting protected
DRM keys is not. The queued worker runs one job at a time between 00:00 and 04:00, checkpoints at
the boundary, and may also be started manually. It prefers 720p and remuxes without re-encoding,
retains and reports audio when video is unavailable, verifies capture audio before consuming a
lecture, and aborts rather than recording silence. Two-times playback is enabled for a player only
after an Owner-run comparison proves its capture complete and intelligible. Browser audio routing
is restored on every exit.

Dependencies and models are prepared by one idempotent Owner-started setup command, never by a
scheduled run. Setup places and verifies model and runtime caches under `mediaRoot/.runtime`.
Acquisition verifies RAID0 and a configurable free-space reserve, initially 100 GB, before writing.
Manual worker runs ignore the overnight time limit.

Acquired artifacts are additive. Withdrawal upstream stops unfinished work after confirmation but
removes nothing already held; successful video, audio and transcript artifacts are never cleaned
up automatically.

## Admitted probe settlement and retained ownership

A probe deadline bounds observation rather than proving filesystem settlement. Artifact/alias and
capacity probes keep their existing deadlines, then separately await admitted I/O and descriptor
closure for a bounded interval. Pending or failed cleanup stops the worker and retains durable
admission evidence; late settlement cannot silently rearm acquisition. A positively settled expired
probe retains its original timeout. This does not establish physical I/O cancellation or explain a
historical stop whose cause was not retained.

Every lock entrypoint first creates an exclusive, synced, positively closed own admission marker
before probing foreign lock metadata. Pending probe cleanup retains that marker until a durable
barrier is positively stored; barrier-write uncertainty cannot silently drop admission containment.
Normal held-lock results remove only their token/inode-bound marker after positive settlement.
Successful acquisition transfers protection to a durably armed queue owner before removal.
Initial marker creation uncertainty requires failed external containment before any foreign probe;
this does not prove physical I/O cancellation. Health/status observe fixed marker metadata only.

New queue owners create a synced, positively closed fixed safety marker before any action. If a
cleanup barrier cannot be stored or lock ownership/storage becomes uncertain, the lock remains.
An armed owner surviving an unclean exit likewise needs Owner-qualified recovery, even after 48
hours. Unknown owner metadata or marker observations cannot authorize stale reclamation. Only
positively recognized legacy stale owners retain the previous reclamation policy. The stricter
unclean-exit rule is necessary because writing a retention marker after storage fails cannot prove
that the marker exists. Lock presence proves admission refusal, never an active process or cessation.

The Owner must establish owned activity cessation and stable storage/evidence before explicitly
removing a positively bound abandoned lock. No command automatically clears these markers or
weakens source review/validation to recover. Refused/global-stop summaries retain cached queue
counts with artifact verification explicitly unrun; they grant no new readiness evidence.

## Consequences

- The codebase gains a second workflow and completeness axis rather than making `sync` unbounded.
- Content-tree player media may consume Drive space; Media Gallery media consumes RAID0 space.
- Private state may be deleted without losing meaning: source digests and non-secret recording
  references in the artifacts reconstruct completed work. Retained cleanup barriers and armed
  owner receipts are admission evidence and require qualified recovery before deletion.
- New provider shapes fail loudly as unsupported until research supplies an adapter.

## Revisit when

- A provider transcript proves materially worse than local transcription often enough to justify
  spending the compute twice.
- Course destinations move to RAID0, removing the reason for the source-dependent storage split.
- The university supplies a durable recording API that makes browser discovery or capture
  unnecessary.
