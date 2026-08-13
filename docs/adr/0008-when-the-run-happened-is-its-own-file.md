# When the run happened is its own file

A destination holds one file recording when the sync last ran — `Last synced.md`, at the root of
each course folder — and every other file in it is a pure function of what NTULearn returned. The
course overview no longer stamps the time into itself.

Two questions were being answered by one line, and they want opposite implementations (#57):

1. **Is my copy fresh — did the sync actually run today?** Answering it means writing every run,
   whether or not the course moved.
2. **When did this course last change?** Answering it means writing only when something else was.

The `- Synced:` line in `Course.md` answered the first, and made the second unanswerable while
charging the destination for it on every run.

## What the one line cost

`courseDocument()` stamped `new Date().toISOString()` into the overview, so `Course.md` differed
from itself on every run and was always written. Nothing else in a destination behaves that way:
`contentDocument`, `uncopiedDocument` and `announcementDocument` are pure functions of the
snapshot, so they are written only when the course moved.

- **Eight files churned every run for no content reason.** Every destination is a Google Drive
  folder, so each run handed Drive eight overviews to re-upload holding nothing new.
- **`markdownWritten` could never reach zero.** #55 added it so that an unattended run can say it
  changed nothing; the floor was one per course, eight on `sync -- all`. A signal with a permanent
  floor is one a reader has to remember to discount, which is most of the way back to the number
  #55 replaced.

## Why the freshness question was not simply dropped

The cheapest fix is to stamp only when the course changed. It makes the date *more* informative —
a date that moves means new material — and reaches zero at the same time. It was rejected on what
it takes away.

This repository is built toward unattended, scheduled runs, and a run nobody watches is a run whose
report is read once on the day it ran, if at all — the same premise `docs/adr/0006` argues from and
`docs/adr/0007`'s *Revisit when* returns to. Under that premise, "did the sync run today?" is the
question the absent Owner most needs answerable, and the destination is the only place they look.
A course that got no new material would be indistinguishable between a sync running nightly and a
sync that died on Monday — a silent failure, which is the failure mode this repository is least
able to afford.

Nothing else records it where the student can see. `state.syncedAt` holds the same moment, but
`.data/` is documented as disposable and is no part of the copy.

## Why not simply exclude the line from the comparison

The fourth option weighed was to keep writing the overview and to ignore the `- Synced:` line when
deciding whether it changed. It was rejected as a report that is true about the count and false
about the disk: the number would say zero while eight files were rewritten and eight uploads went
out. `docs/adr/0005` refuses a report nobody trusts on the grounds that it is a report nobody runs,
and a number that disagrees with the filesystem is the shortest route to one.

## Consequences

- **A destination gains a file the student did not ask for, permanently.** One per course, and
  `docs/adr/0003` means nothing ever removes it. It says what it is in its own body, because a file
  nobody asked for that does not explain itself is worse than the churn it replaced.
- **The churn is reduced rather than removed.** Eight small files are still rewritten every run and
  still re-uploaded. What changes is that they are a line each instead of a whole overview, and
  that nothing a reader is watching moves with them.
- **`markdownWritten` can now reach zero, and zero means no document moved.** A run over eight
  unchanged courses writes no *document*, which is the sentence #55 wanted the number to be able
  to say. It does not mean nothing was written: the eight stamps were. That is the qualification
  the fourth option could not make — there the number would have said zero while the overviews a
  reader actually reads were rewritten, where here it says zero about the set it names, and the
  file it stays silent about is one whose whole purpose is to move.
- **`verify` counts the stamp in neither number.** It is a record of the run rather than a document
  of the course, so counting it would put the floor back one level up — every course would hold one
  file that is present whenever a sync ever ran, and absent only when everything else is too. It is
  named in the report's *not covered* list rather than passed over in silence, which is `#36`'s
  discipline and `docs/adr/0005`'s.
- **The first run after this lands rewrites every overview once.** The `- Synced:` line is removed
  from `Course.md` in each destination. That is the sync's own writing being corrected, which costs
  the student nothing — the same ground #53 stands on.
- **The overview is now a pure function of the snapshot, like everything else.** There is no longer
  a document in the destination that behaves differently from its neighbours, which removes the
  exception every future reader of the write path would have had to hold.
- **A stamp says the run happened, not that it went well.** It is written whatever the walk found,
  so a run whose downloads failed still stamps the destination. That is the freshness question
  answered honestly — the sync did run — and it is deliberately not a health signal: what failed is
  the run's report, and what is missing is `verify`'s (`docs/adr/0005`).

## Revisit when

- **Something downstream starts reading the stamp.** It is written for a person opening the folder.
  A consumer parsing it makes its shape a compatibility surface, which it is not today.
- **A run's report becomes durable somewhere else.** `docs/adr/0007`'s *Revisit when* already
  anticipates an unattended run needing its findings kept rather than printed. If that lands in the
  destination, this file is either where it goes or a thing beside it that should not have been
  separate.
- **The extra file starts costing more than it answers.** If the Owner stops reading it, the case
  above collapses into the option this record rejected, and stamping only on change is one line.
