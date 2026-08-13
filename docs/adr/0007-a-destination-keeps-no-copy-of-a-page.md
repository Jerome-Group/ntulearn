# A destination keeps no copy of a page

A destination holds the Markdown a sync writes and the attachments it downloads, and nothing else.
The HTML a content item arrives as is read, converted, and dropped — exactly as it is today. It is
kept neither as a record nor as a browsable artefact, and nothing derived from it is allowed to
answer "is this course complete?".

This is recorded because keeping the source is the obvious instinct and the one a contributor will
propose: the conversion is lossy and one-way, and the HTML is what it was lossy about. Both reasons
given for keeping it were weighed and both lose, for different reasons (#41).

## The body is not the page, and it is the body that was on offer

`CONTEXT.md` now separates the two. A **body** is an item's text as NTULearn's read API returns it.
A **rendered page** is that item as it appears to the signed-in student. NTULearn writes a body when
an item is authored and does not revisit it, so the addresses in a body go stale while the page
moves on.

This is measured rather than argued. On CC0006, four `<img>` elements in the body carry
`/sessions/<id>/…` addresses which return NTULearn's error page to a real browser carrying real
cookies. The rendered page serves those same four images from `rid-64471195_1`, `rid-64471196_1`,
`rid-64471192_1` and `rid-64475503_1` — every one byte-identical, by digest, to a file already in
the destination (#40).

So a saved body is a document whose own images do not load, filed under a name that claims fidelity
to a page it does not match. `CONTEXT.md` says the student's view bounds this domain; a body is
NTULearn's model of that view, and the two have been measured to differ on a course being taken
this term.

## Nor can it say whether the copy arrived

The second reason offered was a completeness check: a saved page whose links can be followed says
whether the files it names actually landed.

A second reader sharing no code with the walk was built and run against eight courses (#29). It
found eleven addresses the walk does not have. **Ten of the eleven were aliases** — a second, dead
address for a file already in the destination, confirmed by digest against the addresses the
rendered page actually resolves to (#40). The eleventh was the literal word `undefined`, which
`isSupplied` rejects before anything could raise it.

Every real candidate was false. A check built on a body's links would have reported ten phantom
gaps across two courses, which is the report `docs/adr/0005` refuses on the grounds that one nobody
trusts is one nobody runs.

The rate is a property of reading a **stored address**, not of following links. An alias is what
NTULearn wrote down, not what loads.

> **Corrected by #47.** This paragraph originally read *"The rendered page has none of them — it
> resolves to the live address, which is why all fourteen digests matched."* That was a falsifiable
> prediction and it was tested against nine courses and **falsified: the rendered page produced nine
> aliases** on `25S1_SLAC03`. Each answers `403` on a `/sessions/…` address while the
> `/bbcswebdav/…/xid-…` the walk holds answers `200` and digests identical to the file already in
> the destination — the same measurement #40 made on CC0006, with the opposite result.
>
> The prediction failed for a reason worth keeping. It is still true of what the browser **resolves
> and fetches**; all nine arrive instead on a `data-bbfile` JSON **attribute**. The gap is that a
> reader on the rendered page cannot live on resolved properties alone: Ultra renders an attached
> file as `<a data-ally-file-preview-url="…">` with no `href`, so an element-shaped reader finds
> *zero* of a course's attachments — measured on `25S2-PS0002-LAB`, where the walk had 90 and the
> page shared none of them until attributes were read. Reading attributes is not optional, and it is
> what carries the stale addresses in.
>
> So the generalisation the evidence supports is stronger than the one made here: **both artefacts
> store aliases, and what removes an alias is fetching the address rather than choosing a different
> place to read it from.**

This is the whole reason the two artefacts are separated above, and it is why disqualifying the body
settles the check without settling which authority replaces it. Nothing in #47 rehabilitates the
body: it was disqualified for being NTULearn's model of a view rather than the view, and that is
untouched.

## Why not the Markdown's place

Replacing the Markdown with HTML was rejected on what the destination is for. The copy feeds a
personal knowledge base and a file-consuming automation, so its product is a Markdown document per
item beside the real files — the PDF, the PPTX, the recording. HTML cannot carry that shape: it has
no way to split an announcement, a tutorial's text and a week's page into the separate documents
that make the copy navigable, and nothing downstream reads it.

Keeping it as a companion was rejected separately: an unstyled body without NTULearn's session-gated
stylesheets is a pale approximation of the page, and for the question it was wanted for — *what is
missing?* — a page is the wrong artefact in principle. A page describes NTULearn's side only. What
answers the question is the difference between the two sides, which is a finding rather than a
document.

## Completeness is relative to an authority, and the report names it

This record does not decide **which** reading of a course a check should trust. It decides that the
body is not a candidate, and it fixes the frame the choice is made in.

There is no absolute completeness here. A number can say that everything the **authority** saw is
accounted for; it can never say that nothing was missed. #29 is the demonstration: its conclusion
was correct about the six addresses it fetched and was asserted of all eleven, and the correction
came from the Owner rather than from the method. So a report names the authority behind its number,
and what that authority does not cover is part of the answer rather than a caveat on it — the same
discipline #36 established.

The candidate under test is the rendered page, because it is the only reading that is true by
construction. It is not adopted here: it costs a page load per item, and the case for it rests on
one course's four images. Validating it against a corpus chosen for variety is its own work, and
fixing an authority on the strength of it sounding true is the mistake #29 already made once.

That work has since been done — #47, nine courses — and it came back against the candidate on three
counts: it produced the nine aliases above, it lost 45 attachments, 5 SCORM packages and 1 LTI
placement while reporting nothing wrong, and on the largest course it ran long enough to trip
NTULearn's own idle-logout. Not adopting it here was right, and #33 is still where an authority is
chosen.

## Consequences

- **The lossy conversion stays lossy, and nothing on disk records what was lost.** An `<iframe>`,
  an `<object>` or an `<embed>` is removed by `src/sync/markdown.mjs` and leaves no trace in the
  destination. That is #33's defect and this record does not fix it — it rules out the fix that
  would have been reached for first.
- **A body's links are never a completeness signal.** Anything that comes to depend on them is
  depending on something this record denies, and the number against it is ten out of ten.
- **No artefact's links are one either, because an alias is not escaped by changing artefact.** A
  stored address is stale wherever it is stored, and the rendered page stores them too — nine, where
  this record predicted none (#47). What tells an alias from a gap is fetching the address: a check
  that compares address sets and stops there reports the aliases as missing files, which is the
  report `docs/adr/0005` refuses.
- **The destination gains no artefact that goes stale.** A rewritten link is derived from what one
  run downloaded, and `docs/adr/0003` means nothing would ever correct it. Not writing it is what
  avoids owning it.
- **`verify` is unchanged by this record.** What it counts is `docs/adr/0005`'s business and #32's.
- **A check that reads NTULearn twice costs a session twice.** Whatever authority is chosen, it is
  a second read of the course, and `docs/adr/0005` already prices the first.

## Revisit when

- **A reader wants the copy to be usable without NTULearn at all.** Files that name a video and a
  quiz without carrying them are a worse experience than an index, which is the shape
  `docs/adr/0006` already predicted this pressure would take.
- **A rendered page is being captured anyway.** If an authority loads every item's page, the DOM is
  in hand and storing it costs a write rather than a read. The argument above is against paying for
  it; it is not against having it free. What it is still against is the *body*.
- **Something downstream reads HTML.** The argument from what the destination is for is an argument
  about today's consumers, and a new one would reopen it.
- **A run happens that nobody watches.** An unattended, scheduled sync has no reader for its
  report, and `docs/adr/0006` already argues that what a run prints is read once on the day it ran.
  Whatever a check finds would then have to be durable rather than printed, and where it is durable
  is this record's question again.
