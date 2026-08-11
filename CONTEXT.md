# ntulearn — context

Reading a student's own NTULearn courses and keeping a copy of them on disk.

## Language

The ubiquitous language of this repository: the words the code, the issues and the commits all
use for the same thing. An entry earns its place when two people — or a person and an agent —
could reasonably mean different things by the same word.

Each entry is the term, what it means **here**, and the near-synonyms to avoid so the wrong one
does not creep back in. What any of it looks like on disk is `README.md`'s business, not this
file's.

### The operation

**Sync**:
Bringing the copy of a course up to date with NTULearn. It is one-way and **additive** — it
writes and it skips, so a destination only grows. Reconciling the two sides is the thing it is
not, and `docs/adr/0003` is why.
_Avoid_: import, download, mirror, scrape, backup — the first two were used interchangeably with
this until they were retired, and the last three each promise something a sync does not do

**Verify**:
Holding a destination against NTULearn and reporting the difference. It reads both sides and
writes to neither, so it answers a question about the destination rather than about a run —
`docs/adr/0005`. Repairing what it finds is a sync's job and never its own.
_Avoid_: check, audit, reconcile — the last is the operation a sync is not, and naming this one
after it invites the deletion `docs/adr/0003` refuses

**Snapshot**:
Everything read from NTULearn for one course in a single run, before any of it is written.
_Avoid_: dump, payload, response

### What is read

**Student**:
The person whose NTULearn account the sync signs in as. Their view bounds the whole domain:
nothing exists here that they could not already see for themselves.
_Avoid_: user, account, member

**Course**:
One NTULearn course. It is the unit a sync operates on and the unit a person configures.
_Avoid_: module, class, subject — "module" is what a student calls it, and also what a `.mjs`
file is

**Content item**:
One node of a course's content tree: a folder, a page, a file, or a link. It may carry text, an
attachment, and a link out, in any combination.
_Avoid_: resource, node, page, entry

**Attachment**:
A file hanging off a content item. It is copied as it is, never converted.
_Avoid_: asset, document, upload

**Uncopied item**:
A content item there is nothing to bring across from — no text, no link, no attachment — because
what it is lives behind an NTULearn interaction: a quiz, a test, a submission point. A sync writes
a document naming it in its place, so the copy says the item exists rather than leaving it out in
silence (`docs/adr/0006`).
_Avoid_: skipped, missing, empty — the first two are what `verify` says about a file that ought to
be in a destination and is not, which is a defect where this is a limit

**Trail**:
Where something is in NTULearn, said in the titles a student would read on the screen — the
folders it sits under, outermost first. It is what a report says alongside the *path*, which is
where the same thing lands in the destination; one finds it in the browser and the other on disk.
_Avoid_: breadcrumb, location, path — the last is the other half of the pair and means the
destination

**Announcement**:
A dated notice posted to a course as a whole, rather than to a place in its content tree.
_Avoid_: notice, post, message

**Conversation**:
A discussion thread on a course. A sync counts the new ones and copies none of them, so a
conversation is something this repository reports on rather than something it keeps.
_Avoid_: discussion, forum, thread

### What is kept

**Destination**:
The folder a course is synced into. It belongs to the person running the sync, and nothing
outside it is ever written. One course, one destination, and no two courses share one or nest
one inside another — a course with a lecture site and a tutorial site is two courses here, and
two trees written into one folder is a tangle a sync cannot undo (`docs/adr/0003`).
_Avoid_: output directory, target, vault

**Session**:
Proof that the student is signed in, reusable across runs. It is this repository's one secret.
_Avoid_: login, credentials, cookie, token — a token is one part of a session, not a word for it

**State**:
What a previous sync recorded about a destination, so the next one can skip what has not changed.
It is a cache and never a source of truth: losing it costs time and nothing else.
_Avoid_: database, index, manifest, cache — the last is what it behaves like, but "the cache"
already means the browser's

### Organisation-wide

Two terms mean the same thing in every repository:

**Organisation**:
The `Jerome-Group` GitHub org — the top-level account that owns the repositories.
_Avoid_: team, group

**Baseline**:
The configuration every repository in the Organisation inherits — branch protection, the
security defaults, and the per-repository settings. It is applied from the management hub, not
from here.
_Avoid_: template, policy, default
