# An uncopied item is written down

A content item that carries no text, no link and no attachment gets a Markdown document of its own
anyway — named and numbered exactly as any other item would be — saying what it is and that there
was nothing to copy. Nothing NTULearn returns leaves the destination without a trace of having
existed.

This is the second half of the promise `docs/adr/0003` makes. That record says a destination only
ever grows; this one says what a run puts in it when the thing it is looking at cannot be brought
across. Together they mean the copy is a superset of the course in the direction that matters: it
may hold more than NTULearn does, and it never quietly holds less.

## What it fixes

A quiz — `resource/x-bb-asmt-test-link`, position 2 of CC0006's Week 1 — produced an empty document
and so no file, between two items that produced one each. The destination held `01, 02, 04, 05, 06`
and the missing `03` was the whole of the evidence, which reads as a bug in the numbering rather
than as an item that was passed over. The week's instructions told the student to take that quiz
between the two videos, and the synced copy gave them no way to know it existed (#20).

An item deliberately not copied is a legitimate limit, and `README.md` states the limits. Omitting
it in silence is a different thing: the copy claims a completeness it does not have, and "the
course has nothing here" becomes indistinguishable from "the tool wrote nothing here".

## Why a document rather than a report

A count in the run's result is the smallest change and reaches the wrong reader. What a run prints
is read once, by whoever ran it, on the day they ran it; the destination is read all term, by a
student who never saw the run. Something absent from the folder is absent from the only copy they
have.

A line in the parent folder's `_NTULearn.md` keeps the near-empty files out of the tree, and pays
for it twice. That document is itself written only when the folder has a description, so the case
of an uncopied item inside an otherwise bare folder would have to conjure the file it is appending
to — and a line inside a document does not hold the position the item occupies, so the gap in the
numbering it was meant to explain stays there.

The document at the item's own numbered place is the option that survives both: the numbering is
continuous, `ls` shows the item where NTULearn shows it, and a grep across a term's courses finds
every quiz and submission point in one pass. The cost is real and small — files whose entire
content is the statement that there is no content.

## Only where nothing else is written

An item whose attachment arrives already leaves that file behind, so it gets no document. Writing
one anyway would put `05 Week 1 PPT.md` beside `05 Week 1 PPT.pptx` on the strength of the item's
body being empty, which is not a gap and not worth a file.

An item whose attachment **fails** to download gets none either, and that is the one place this
record leans on something outside the destination. The run names the failure and exits `1`, but
the argument above says a run report is read once — so the reason the case is different is
`verify`, not the report. A file that ought to be in the destination and is not is exactly what
`verify` counts, on every future run, for as long as it stays absent (ADR-0005). An uncopied item
was invisible to it: there was no attachment to expect, so nothing was ever held against anything.
That asymmetry is the whole of why one gets a document and the other does not, and it survives #32
— which closed the blindness rather than the asymmetry, since the failed download is still covered
by the attachment `verify` expects and the uncopied item is now covered by the document this record
has it write. Writing one for the
failed download would also put a false sentence on disk — the item does carry an attachment — and
ADR-0003 means nothing would ever take it back off.

A folder is untouched by this. It is a directory on disk whether or not it has a description, and
the directory is the trace.

## A document is never written over a page

An item hidden behind a release rule comes back carrying nothing, which is indistinguishable from
an item there was never anything to copy from — the failure mode ADR-0003 builds its case on. So
the document is written only where the destination holds nothing at that path, **or where what it
holds is one of these documents already**. A page an earlier run copied stays exactly as it was,
and the item is still counted as uncopied for the run that saw it empty.

This is the same asymmetry ADR-0003 draws, one level down: a stale page costs a reader nothing,
and replacing a student's copy of a week with the sentence "there was nothing to copy" destroys
material they may no longer be able to reach.

The asymmetry is between a **page** and a **document**, and not between a first write and a second
one. A document is this repository's own sentence about an item, so nothing of the student's is
lost by correcting it, and a destination written before a fix would otherwise repeat what the fix
removed forever — which is what ML0004's seven SCORM topics did, still naming a raw handler after
#49 had translated it and still saying they carried no link after #53 found the one they carry.

What tells the two apart on disk is a mark the document carries for the purpose,
`<!-- ntulearn: nothing to copy -->`, which renders as nothing and is addressed to the next run
rather than to the student. A document written before the mark existed is recognised by its
sentence instead — the weaker test, and the reason that sentence is now fixed for good (#53).

## Consequences

- **The destination gains files that hold no course content.** One per uncopied item, forever,
  because ADR-0003 means nothing removes them. If NTULearn later fills the item in, the real page
  is written over the document, and a document may be written over a document. What never happens
  is a document over a page — that is the direction overwriting does not run in.
- **A run says how many it could not copy, and that count is not a count of new files.** Every
  uncopied item is counted, whatever is on disk. Its document is written again where the
  destination holds nothing or holds one of these documents — which changes nothing unless the
  text has moved — and is not written at all where a page is in the way. So `uncopied` and
  `markdown` are both about the course: the items it could not copy, and the documents the copy
  holds for it. What this run did is `markdownWritten`, which counts a document only where the
  bytes on disk actually moved (#55). A report is still a report; it is just no longer the only
  record. **Amended by #57:** that number had a floor of one per course when this was written,
  because the course overview stamped the run's own time into itself and so differed from itself
  every run. The stamp is now a file of its own and the floor is gone, so a run that changed
  nothing counts zero — `docs/adr/0008`.
- **The mark in a document is a compatibility surface.** A document carries
  `<!-- ntulearn: nothing to copy -->` so a later run knows its own writing however the words
  around it change. What predates the mark is recognised by its sentence instead, so *that*
  sentence can never be reworded without stranding every destination written before this record —
  which is the cost of having had no mark for the first year, paid once.
- **The kind is NTULearn's word for it.** The document names the content handler, translated where
  a student would not recognise the raw key and passed through where they would. A handler nobody
  has seen yet is reported as NTULearn spells it rather than guessed at.
- ~~**`verify` is unchanged.**~~ Amended by #32. It was true of the command as it stood: `verify`
  read attachments against the destination, and an uncopied item has none, so there was nothing for
  it to hold the destination against. But the document this record requires is a file a sync now
  promises to write, which makes it exactly the kind of thing `verify` can hold a destination
  against — so it counts one, and the *asymmetry* above holds for the reason it always did. An item
  whose attachment failed to download is covered by that attachment; an item there was nothing to
  copy from is covered by its document. Neither is invisible now.

## Revisit when

- **An item turns out to be copyable after all.** A test's questions, a submission point's
  deadline: if a read the student is allowed to make would return them, the fix is to copy them and
  the document for that kind stops being written. This record blocks nothing there — it is about
  what happens when there is genuinely nothing to bring across.
- **The documents outnumber the content in a folder.** A course built mostly from LTI links would
  do it. That is the argument for the parent-folder line, and it needs a real course rather than
  the theory.
- **A student wants the copy to be printable, or fully readable offline as a set.** Files that say
  "open this in NTULearn" are a worse experience there than a single index, and the shape of the
  answer would be an index rather than a retreat to silence.
