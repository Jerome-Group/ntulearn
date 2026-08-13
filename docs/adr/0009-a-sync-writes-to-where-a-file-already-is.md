# A sync writes to where a file already is, not to the number the course gives it today

Before writing anything a course expects, a sync asks the destination whether it already holds that
file under a name differing only by the number in front of it. Where it does, and the bytes there
are the bytes the run would write, the run writes nothing: the file stays where it is and is counted
as skipped. Where the bytes differ, the older file is left exactly as it is and the run writes at
today's number beside it, as it always did. The number in a name stays the item's `position`,
nothing on disk is renamed, nothing is deleted, and nothing this run did not itself just fetch is
written over — ADR-0003 holds exactly as it did.

It answers the duplication ADR-0005 named and deferred. A file's name carries its item's position,
so one item inserted at the top of a course moves every later name by one while nothing on disk
moves — and `saveAttachment` held its record to the path the run *would* write:

```js
record.relativePath === placement.path      // ← the number moved, so this is false
```

The bytes were identical and the file was already there, and the run fetched it again under its new
number. Measured on 2026-08-13, `MH2100` had 61 attachments in that state and `MH2500` had ten:
71 duplicate files on the next sync of two courses, with nothing to say which copy was current.
Documents went the same way, written from the snapshot at whatever name the current numbering gave
them.

#67 stopped the report *causing* this — `verify` counts a renumbered file present and no longer
prints `npm run sync` as the remedy for it. It could not stop a sync run for any other reason, which
in a repository built for unattended runs is the case nobody is watching.

## What this is not: a second identity

The tempting reading is that the destination now has its own idea of where a file lives. It does
not. The lookup is the one `verify` already makes (`src/sync/numbering.mjs`), on the same terms: a
file stands in for one at another number only inside the folder that expects it, and only where the
name inside the number is that folder's alone. Two items in a folder may share a title, and then the
run guesses nothing and writes at today's number, which is what it did before.

That shared lookup is the point. `verify` calls such a file **present**; a sync now agrees by not
writing it a second time. The two commands disagreeing about whether a file is there was the defect,
not the numbering.

Where the two commands part is what they do with the answer. `verify` never opens a file, so a file
left behind for an item NTULearn has stopped returning may carry the title of one that moved and be
counted present — the limit ADR-0005 accepts and prints on every run. A sync cannot accept that
limit, because behind its answer is a write: it would be overwriting a file it did not put there,
possibly annotated, on nothing better than a matching title. So a sync **compares the bytes** before
it leaves anything in place, and writes at today's number whenever they differ. The check is loose
enough to find the file and the write is strict enough to be safe.

## Why not the alternatives

**Record the position at first write, in `State`.** The number would stop moving. It would also make
`State` the thing that decides what a destination is called, and `State` is documented as a cache
that costs nothing to delete (`CONTEXT.md`, *State*; ADR-0003). This decision deliberately leans the
other way: the answer comes off the disk, so a run with no state at all still writes to where the
file is rather than beside it — it re-fetches the bytes, which is the only thing losing `State` is
supposed to cost.

**A stable id in the name.** Identity that never moves, at the price of a name no student can read
and a one-time rewrite of every destination — a rename, which is what ADR-0003 refuses.

**Renumber on disk.** A rename is a delete and a create to Drive and to anything watching the
folder, and it reaches the student's own annotated copies as readily as ours. ADR-0003 argues the
whole of this; nothing here is new enough to reopen it.

**Accept the duplication.** The status quo. It costs 71 files across two courses today and grows
with every insert upstream, in a copy whose whole value is that a student can find the current
version of something.

## Consequences

- **`ls` shows the order the files arrived in, not NTULearn's.** This is the accepted cost, and it
  is permanent: nothing renumbers a destination, so a course reordered often enough drifts as far
  as the reordering goes. `verify`'s `renumbered` list is where that drift is legible, and it is
  now the only reason that list exists.
- **A run reports a `renumbered` count** — how many of the files it expected the destination already
  held under an earlier number. It says the numbering has moved without anybody running `verify`,
  and it is deliberately not a count of what was skipped: a file whose bytes differ is renumbered
  and written anyway.
- **A course is read whole before any of it is written.** Where a file belongs is decided among
  every name the course expects, so the walk is collected before the first download rather than
  written as it streams. Two things follow. A run that dies mid-walk now writes nothing instead of
  part of a course, which is an improvement nobody asked for; and every document's rendered text for
  one course is held in memory at once, which is a page each and a course at a time.
- **A reordered course still gains an empty folder per renumbered folder.** A folder is a directory
  rather than a file, and this asks about files, so `mkdir` at the new number still runs. The
  duplication that costs something — a second copy of the bytes — is what this record removes; a
  directory holding nothing is ADR-0003's accepted untidiness.
- **An attachment with no record is fetched to compare against.** Where `State` is gone and the
  numbering has moved, the run spends the download and then writes nothing. That is the cost of the
  answer coming off the disk rather than out of a cache, and it is bounded by how often `State` is
  thrown away.
- **The stale numbering is now invisible in the ordinary case.** Before, a reordered course
  announced itself by growing; now it quietly stays as it was. Anybody who wants NTULearn's order
  in the destination has to ask for it, and asking for it is a rename.
- **`verify`'s warning is gone.** The stderr line saying how many files a sync would write a second
  time described a cost this record removes.
- **A file left behind for an item NTULearn has stopped returning is never written over**, even
  where it carries the title of one that moved: the bytes decide, and the run writes at today's
  number when they disagree. So the duplication this record removes comes back in exactly that case
  — which is the trade taken deliberately, because the alternative is overwriting somebody's file
  on the strength of a name.

## Revisit when

- **Somebody wants the destination in NTULearn's order.** That is a renumbering, and it is
  ADR-0003's *Revisit when* rather than this record's — a rename of files this repository wrote,
  in a folder somebody else also writes to.
- **The number stops being the item's position.** This record is built on names that differ only by
  that number. If names come to differ some other way, the lookup underneath it is answering a
  question nobody is asking.
- **Two items in one folder sharing a title stops being rare.** Then the case this refuses to guess
  at is the case that matters, and what identifies a file needs settling rather than skipping.
