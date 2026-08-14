# A sync never deletes from a destination

A sync is **additive**: it writes and it skips. It leaves a file NTULearn no longer returns, keeps
the folder that held it, and answers an upstream rename by writing the new name beside the old
one. A destination therefore accumulates, and the copy is a superset of the course rather than a
match for it. *Additive* is the word for this everywhere — the glossary, `AGENTS.md`, and the
code.

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

**Narrowed for renaming, not for deleting — `docs/adr/0010` (#74).** The paragraph above is an
argument about evidence: a record of the past cannot tell you about the present. `docs/adr/0010`
takes it at its word and supplies the present — the `sha256` in that record, held against the bytes
on disk now — and renames only what still matches, in a command of its own. Nothing here is
weakened: a sync still never deletes and still never renames, and the deletion this section refuses
is refused everywhere, with or without evidence.

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
  (`docs/adr/0009` stopped the writing-beside; `docs/adr/0010` is where the order gets put back,
  deliberately and never by a sync.)

## Revisit when

- **A user asks to be told what went away.** Reporting a disappearance is not deleting it, and it
  is the useful half of what a mirror would have given. That is a feature this record does not
  block.
- **A destination that this repository provably owns exists** — a scratch folder it created and
  nothing else writes to. The argument above is about somebody's own folder; it does not reach a
  folder nobody else touches.
- **Somebody hits a real disk-space wall**, which is the one cost that is not merely untidy.
