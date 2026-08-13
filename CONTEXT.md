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

**Authority**:
The reading of a course that a check treats as the truth about what exists. Completeness is always
relative to one: a number can say that everything the authority saw is accounted for, and never
that nothing was missed. So a report names the authority behind it, and what that authority does
not cover is part of the answer rather than a caveat on it.
_Avoid_: source of truth, ground truth — both claim an absoluteness no reading here has

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

**Refused course**:
A *course* NTULearn will not hand over to this *student* — closed at the end of its semester, or
one they are no longer enrolled in. It is a fact about the course rather than about the run: it is
the same on every run, and no *session* opens it, so a command names it in its report and carries
on to the next course (`docs/adr/0005`). A configuration this repository refuses at startup is a
different thing entirely, and only the first is ever `refused` in a report.
_Avoid_: failed, unavailable, forbidden — the first two say something went wrong or might come
back, and the last is the HTTP status rather than the fact

**Content item**:
One node of a course's content tree: a folder, a page, a file, or a link. It may carry text, an
attachment, and a link out, in any combination.
_Avoid_: resource, node, entry — and *page* on its own, which names a kind of content item here
and never the item itself

**Content handler**:
What a *content item* is, in NTULearn's own key for it — `resource/x-bb-file`,
`resource/x-bb-folder`, `resource/x-plugin-scormengine`. The set is open rather than fixed: a
*Building Block* brings its own, so no published list closes it
(`docs/research/does-blackboard-document-the-content-handlers.md`). What a report shows a student
is the **kind** — the handler said in a word where somebody has supplied one, and the handler
itself where nobody has (`docs/adr/0006`).
_Avoid_: type, content type — and *kind*, which is the word for what a student reads; the two part
company exactly where a handler has no translation, which is the case worth being clear about

**Building Block**:
Blackboard's word for a plugin installed into NTULearn. It may bring *content items* of its own
and a *content handler* to name them — SCORM is one. What is installed is the institution's
choice, which is why this repository can meet a handler no vendor documentation lists.
_Avoid_: plugin, extension — and *integration*, which is Blackboard's word for a registered REST
API client and names a different thing

**Body**:
A content item's text as NTULearn's read API returns it. It is NTULearn's stored record of the
item, written when the item was authored and not revisited, so it is not what a student's browser
shows: an address in a body can be dead while the *rendered page* serves the same file from a live
one.
_Avoid_: content, html, source — the last claims a fidelity a body has been measured not to have

**Rendered page**:
One content item as it appears to the signed-in student in the browser, after NTULearn has
resolved its *body* into a page. It is the only reading of an item that is true by construction,
because the student's view is what bounds this domain.
_Avoid_: DOM, view, page — the last is the word `Content item` gives up, so these two stay
together

**Attachment**:
A file hanging off a content item. It is copied as it is, never converted. It is the file, not the
address it was fetched from — one file may have several addresses and only one of them need work.
_Avoid_: asset, document, upload

**Document**:
A Markdown file this repository writes about a course rather than one NTULearn hands over: the
course overview, a folder's own page, a *content item*'s page, an *uncopied item*'s stand-in, an
*announcement*. That authorship is the whole of what separates it from an *attachment*, and it is
why a later run may correct its own sentence in one (`docs/adr/0006`). Both are files a
*destination* is expected to hold, so `verify` counts both.
_Avoid_: note, markdown file, page — the last names one kind of document and not the set

**Alias**:
A second address for an attachment, written down when an embed was authored and since moved off by
the file. It answers `404` or `403` where another address the same course carries serves the bytes,
and the file it names is already in the destination under its own name. An alias is not a defect
and nothing is missing because of one. A *body* carries them and so does a *rendered page* — the
page stores one in a `data-bbfile` attribute even while it fetches the live address (#47), so an
alias is a property of a stored address rather than of either artefact.
_Avoid_: dead link, broken link, duplicate — the first two say the file is gone, and it is not

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
