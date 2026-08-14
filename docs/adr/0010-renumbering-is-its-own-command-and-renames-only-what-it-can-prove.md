# Renumbering is its own command, and it renames only what it can prove it wrote

`npm run renumber -- <course|all>` puts a destination back into the order NTULearn gives the course
today. It renames a file only when it can prove the sync wrote it and nothing has touched it since —
the `sha256` a download recorded, or, for a document, the text the walk is holding. Everything else
is left exactly where it is and named in the report. It deletes nothing, writes over nothing, and
never renames onto a name that holds something.

It is a **command of its own**. A sync does not renumber, does not gain a flag that renumbers, and
still never renames anything: ADR-0003 is untouched as a statement about what a sync does.

## What it is for

A name carries its item's `position`, and ADR-0009 stopped a reordered course duplicating itself by
leaving those files where they are. That fixed the copy and accepted the order. Measured on `MH2500`
on 2026-08-14, immediately after the ADR-0009 sync, the destination held two files numbered `01`:

```
01 Hand03_Part_2_MH2500-2026.pdf     written when it was at position 0
01 Tutorial 01_2026.pdf              the item inserted at the top this week
```

Complete, current, and not in the course's order — with nothing in the repository that would put it
back. ADR-0009's *Revisit when* named exactly this condition, and #74 is it arriving.

## Why ADR-0003's argument does not reach this

ADR-0003 refuses the rename along with the delete, and its reasoning is worth quoting rather than
paraphrasing: the state file "says what this repository wrote, not what the student has since done
with it — renamed it, annotated it, moved it into a folder of their own." A rename informed by state
is still a rename of a file somebody may be using.

That is right, and it is an argument about **evidence**, not about renaming. It says a record of the
past cannot tell you about the present. A digest can: `State` already carries a `sha256` for every
attachment it downloaded, and a document is a pure function of the snapshot, so both can be held
against the bytes on disk *now*. A file that still matches is one nobody has touched, and that is
not an inference — it is a measurement.

So this record does not overturn ADR-0003's reasoning; it satisfies the condition that reasoning
was protecting. Where the evidence is absent — no recorded digest, or bytes that no longer match —
nothing happens to the file and the report says which and why. The safe direction is the default,
and it is the default in the code rather than behind a flag.

## Why not a flag on `sync`

`sync --renumber` is one line and was rejected on where a sync runs. This repository is built toward
scheduled, unattended runs, and a rename is a delete and a create to Google Drive and to anything
holding a path to the file. The failure mode of getting it wrong at three in the morning is a folder
somebody depends on, rearranged, with nobody watching — and a flag whose real risk is invisible in
the crontab line that carries it.

A separate command also keeps a sync's promise simple enough to state in one sentence, which
ADR-0005 already argued for when it kept `verify` out of `sync`. Three commands, three sentences: a
sync writes what is missing, `verify` reads both sides and writes to neither, and this one moves what
it can prove.

## What is guaranteed, and how

- **No name is ever written over.** A file takes its new name by `link`, which fails outright when
  the name is taken, and only then does the old name let go — `rename` would have replaced whatever
  was there silently. A directory has no such trick, so the name is looked at first, and the kernel
  refuses one holding a file or a non-empty directory regardless.
- **Nothing moves between folders.** The new name is made inside the directory the file is already
  in, so this only ever changes the number in front of a name.
- **No rename waits on another, so there is no cycle.** A file is a candidate only because the walk
  found it under a name that is *not* today's — which is to say the name it wants held no file when
  the run looked. Two items cannot want one name either, since a name is a folder and a title and
  the walk yields each item once. This is why there is no temporary name anywhere in it: a temporary
  name is one nothing recognises if the run dies holding it.
- **Files are renamed before folders, and folders from the deepest up**, because every path was read
  before any of this and renaming a parent first would invalidate every path beneath it.

## Consequences

- **A rename still breaks anything holding the old path.** A Drive share link, a link from the
  student's own notes, a shortcut. The digest proves nobody edited the file; it proves nothing about
  who linked to it, and this record cannot. That is the cost, it is why the command is opt-in, and
  it is the thing to weigh before running it — not after.
- **Google Drive re-uploads every renamed file.** A rename is a delete and a create to a sync client.
- **A folder is renamed on weaker evidence than a file.** It holds no bytes to hold against anything,
  so what carries it is that it is a directory this repository created and named, and that everything
  inside it moves with it intact. A student's own files inside a course folder move with it too —
  their paths change, and nothing is lost.
- **`State` is read and never written.** A renamed file leaves its record naming the old path, and
  the next sync finds the file at its new name, skips it, and corrects the record itself. So this
  command cannot corrupt the cache, and losing the cache costs a run of this command rather than
  anything permanent.
- **Losing `State` means attachments cannot be renumbered until the next sync.** No digest, no
  evidence, no rename — the report says so for each one. Documents are unaffected, because their
  evidence is the walk rather than the record.
- **An annotated file keeps the old number for good.** Renumbering will never reach it, so a
  destination with one becomes permanently mixed. That is the correct trade and it is loud: the
  report names the file every time it runs.
- **`verify` is unchanged.** It reads both sides and writes to neither. Its `renumbered` list is now
  a thing with a remedy, where before it was only a fact.

## Revisit when

- **A cycle becomes possible.** The no-waiting argument above rests on a name being a number *and* a
  title. If a name ever becomes the number alone, two items can want each other's names and this
  needs a way to break that which is safe against dying halfway.
- **Somebody wants the old name kept.** A symlink or an alias at the old path would answer the
  broken-link cost, and it is the one part of that cost this record leaves entirely unaddressed.
- **A destination this repository provably owns exists.** ADR-0003 names the same condition. Inside
  one, the evidence this record spends its length on is not needed at all.
- **The proof starts refusing files it should not.** A PDF that Drive or Preview rewrites in place
  would fail its digest forever while being, to a reader, untouched. If that turns out to be common,
  what counts as evidence is the thing to reconsider — not whether to require it.
