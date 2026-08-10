# A sync never deletes from a destination

A sync writes and skips. It never removes a file from a destination, never prunes a folder that
NTULearn no longer returns, and never moves a file that has been renamed upstream — it writes the
new name and leaves the old one. A destination therefore accumulates, and the copy is a superset
of the course rather than a match for it.

This is the decision the word *sync* would lead you to expect the other way round, so it is
recorded rather than left to be inferred from the absence of an `unlink` call.

## Why not mirror

Mirroring — making the destination match the snapshot — is the obvious reading of the word and the
one a contributor will propose. It loses on what a destination is.

A destination is a folder inside somebody's own Drive, named for a course they are taking. It is
not a cache this repository owns, and the person running the sync will put their own notes,
their own annotated PDFs and their own working files in it, because that is what the folder is
for. A mirror deletes those. Every safeguard against that — an ignore list, a manifest of
"files we wrote", a dry-run flag — is a mechanism for being trusted with an irreversible
operation, and the alternative is to not need the trust.

The failure modes push the same way. NTULearn hides content by release rule, and an instructor
un-publishing a week makes those items vanish from the API; a mirror would delete the student's
copy of material they were legitimately shown, at exactly the moment they can no longer get it
back. A partial read — an expired session, a 404 on a folder — has the same shape and would be
indistinguishable from a course that genuinely shrank.

The asymmetry decides it. The cost of not deleting is a stale file nobody asked for. The cost of
deleting is coursework destroyed during the term it is needed, from a program run unattended, on
material the student may have no other copy of. One is untidy and the other is unrecoverable.

## Why the state file is not a licence to delete

`State` records what a previous sync downloaded, so a future change could in principle diff it
and remove what has gone. That would be the same decision wearing a better-informed hat: the
record says what this repository wrote, not what the student has since done with it — renamed it,
annotated it, moved it into a folder of their own. A deletion informed by state is still a
deletion of a file somebody may be using.

## Consequences

- **A destination grows and is never tidied.** A renamed upstream file appears twice, and a
  withdrawn one stays. That is the accepted cost, and it is the user's to clean up.
- **The copy cannot be trusted to reflect the course.** "Present in the destination" does not mean
  "still on NTULearn". Anything that comes to depend on the reverse is depending on something this
  record denies.
- **`State` is only ever an optimisation.** Deleting it costs a re-download, which is the
  property that lets it be thrown away whenever it is inconvenient.
- **Numbered folder names carry NTULearn's ordering into the destination**, so a reordered course
  writes new folders beside the old ones rather than renaming them. Same cost, same reason.

## Revisit when

- **A user asks to be told what went away.** Reporting a disappearance is not deleting it, and it
  is the useful half of what a mirror would have given. That is a feature this record does not
  block.
- **A destination that this repository provably owns exists** — a scratch folder it created and
  nothing else writes to. The argument above is about somebody's own folder; it does not reach a
  folder nobody else touches.
- **Somebody hits a real disk-space wall**, which is the one cost that is not merely untidy.
