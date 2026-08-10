# ntulearn — context

Reading a student's own NTULearn courses and keeping a copy of them on disk.

## Language

The ubiquitous language of this repository: the words the code, the issues and the commits all
use for the same thing. An entry earns its place when two people — or a person and an agent —
could reasonably mean different things by the same word.

Each entry is the term, what it means **here**, and the near-synonyms to avoid so the wrong one
does not creep back in.

**Sync**:
The one operation this repository performs: read a course from NTULearn and write what changed
into its destination. It is incremental and it never deletes, so "sync" here means *bring the
copy up to date*, not *make the two sides identical*.
_Avoid_: import, download, mirror, scrape, backup — the first two were used interchangeably with
this until they were retired, and the last three each promise something a sync does not do

**Course**:
One NTULearn course, and the unit a sync operates on. A configured course is an entry in
`config/courses.json`: a `key` to type at the command line, NTULearn's `courseId`, and the
`destination` it syncs into.
_Avoid_: module, class, subject — "module" is what a student calls it and what a Drive folder is
named, and it is also what a `.mjs` file is

**Destination**:
The folder on disk a course syncs into. It belongs to the person running the sync, never to this
repository, and nothing outside it is ever written.
_Avoid_: output directory, target, vault

**Snapshot**:
Everything read from NTULearn for one course in a single run — the course, its content items,
its announcements and its conversations — before any of it is written.
_Avoid_: dump, payload, response

**Content item**:
One node of a course's content tree as NTULearn returns it: a folder, a page, a file, or a link.
Its attachments and its external link are read off it; it is not itself a file on disk.
_Avoid_: resource, node, entry

**State**:
`.data/state.json` — what has already been downloaded, per course, so the next sync can skip it.
It is a cache of facts about the destination, so deleting it costs a re-download and nothing else.
_Avoid_: database, index, manifest

**Session**:
The saved, signed-in Chrome profile in `.data/chrome-profile`, and the XSRF token captured from
the page it loads. It is the repository's one secret.
_Avoid_: login, credentials, cookie, token — the token is one part of the session, not a synonym
for it

Two terms are Organisation-wide and mean the same thing in every repository:

**Organisation**:
The `Jerome-Group` GitHub org — the top-level account that owns the repositories.
_Avoid_: team, group

**Baseline**:
The configuration every repository in the Organisation inherits — branch protection, the
security defaults, and the per-repository settings. It is applied from the management hub, not
from here.
_Avoid_: template, policy, default
