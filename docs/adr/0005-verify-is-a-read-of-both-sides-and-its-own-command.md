# Verify is a read of both sides, and it is its own command

`verify` walks a configured course in NTULearn, resolves every attachment to the path a sync would
give it, and reports which of those paths hold a file. It downloads nothing, writes nothing and
deletes nothing, on either side. It is a command of its own — `npm run verify -- <course|all>` —
rather than a flag on `sync`.

It exists because a sync reports on its **run** and the question worth asking is about the
**destination**. Every gap found in the first weeks of use was found by opening NTULearn in a
browser and comparing by hand; none of them announced itself, because a run that skipped nothing
and failed at nothing has nothing to say about what an earlier run missed.

## Why not a flag on `sync`

`sync --verify` reads as the cheaper option — one walk, one command to learn. It loses on what the
answer would mean. A sync that verified as it went would fill a gap and then report it as filled,
so its answer would once again be about the run: the only destination it can describe is the one
it has just finished changing. Asking "is this course complete?" has to be possible **without**
changing the answer while asking it, including when there is no session to write with, when the
Drive folder is read-only, and when the person asking does not want a download.

The separation also keeps `sync` from growing a mode that turns its writes off, which is a flag
whose failure mode is that somebody believes it and it was not honoured.

## Attachments only — amended: the documents too (#32)

> The report counts attachments and names the ones that are absent. Markdown documents are written
> from the snapshot on every run, so a missing document means a missing content item — which is a
> different defect, in the walk rather than in a download, and one the sync itself would have to
> have been blind to. The gap this answers is the file that did not arrive.

That was this section, and this record's *Revisit when* named the condition that would change it.
The condition arrived. The report now counts every file a sync promises to write — the course
overview, a folder's own document where it has one, each content item's page, the document an
uncopied item gets (ADR-0006), and each announcement — alongside the attachments.

What the paragraph above gets wrong is the word *different*. A missing document does mean a defect
in the walk rather than in a download, and the walk is the part with the history: three silent skips
(#17), a Learning Module whose children were never walked at all (#18), an item that wrote no file
(#20). Every one was found by opening NTULearn in a browser. Worse, the blind spot fed itself — an
item the walk misses expects no attachment, so the count it is missing from is a count it was never
in — which left the number vacuously satisfiable. `ML0004-TUT` is fourteen content items and no
attachments, so the entire check was `0 === 0`: it reported the course complete, and would have
reported exactly that if the destination were empty or the volume unmounted. On `25S2-PS0002-LAB`,
44 of 126 items are recorded lectures held as external links, carrying no attachment between them;
deleting every one of those pages left the course reading complete.

Counting documents does not detect what the walk missed, and nothing here claims it does — an item
that was never returned still expects nothing, which is why the report now says so out loud. What it
removes is the case where the number is empty of its own accord, and it holds the destination
against everything the run it is checking actually wrote.

Two things bound it, and both are in the code rather than in this prose:

- **A document is expected only where a sync would write one.** A folder's own document exists only
  where the folder describes itself, so expecting one beneath every bare folder would invent a gap
  under each — crying wolf at the smallest possible scale, which is the failure *Presence, not
  content* refuses below for a bigger one.
- **`verify` still never enumerates the destination.** It reads at the paths NTULearn named and
  nowhere else, so a document left behind for an item NTULearn has stopped returning is invisible to
  it rather than excused by it. ADR-0003's additive rule holds here by construction, not by a
  carve-out that some later walk could be written against.

## What a permanent failure does to the exit code is left open

Issue #21 asked a third question with these two: whether a known-permanent upstream failure can be
told from a transient one, so that it stops reddening every future exit code. It is **not settled
here**, and the reason is that the evidence for it evaporated. The ten failures that raised it
turned out not to be upstream at all — #26 found the sync had been asking for a snapshot URL
NTULearn never revisits — and there is now no example in hand of a file that genuinely cannot be
fetched. Building a permanence rule against a case nobody can produce is guessing at its shape.

This command inherits the question rather than answering it: a file that can never be downloaded
is absent on every run, so `verify` goes red on it forever, exactly as the issue complains a sync
did. The difference is only that a red `verify` says something that stays true — a file is not
there — where a red `sync` said a download failed once. That is a better red, not an answer.

## A course NTULearn refuses is a fact the report carries — added (#66)

The section above is about a *file*, and it stays open. One course above it is now settled, because
the example the file-level question never got is ordinary at the course level: a course closes at
the end of its semester, answers `403` from then on, and `npm run login` opens nothing. Three of
seventeen configured courses were in that state, and the first of them ended the whole run before a
line reached stdout — so `verify -- all` had reported nothing about any of the other sixteen for
weeks, which for a scheduled run is indistinguishable from passing.

A refused course is therefore **carried in the report and does not redden the exit code**, which is
the answer #32 gave one level down for an announcements category nobody could read. The three parts
of it:

- **Only a `403` naming a course survives into a report.** A `401` is a lapsed session, whose remedy
  is a person at an MFA prompt and which would refuse every course after this one too, so it still
  ends the run. `src/ntulearn/read.mjs` decides which of the two a refusal is, and hands back the
  kind rather than a sentence for somebody downstream to pattern-match.
- **It is beside the courses, not among them.** A course that was never read has no `files` and no
  `present`, so a row like the others would be zeroes that came from nowhere — the vacuous count the
  amendment above exists to remove. It goes in a `refused` list, named and reasoned, and `sync`
  carries the same list for the same reason.
- **`complete` is unchanged by it.** Not because the gap does not matter, but because there is no
  remedy to point at: the count means *everything this run read is accounted for*, and what the run
  could not read is said out loud in `notCovered` and in `refused` rather than folded into a number.
  A permanent red is one nobody reads, and it would mask the transient reds that do have a remedy.

What this does not settle is the file-level question, which still wants an instance. It also does
not make a refusal invisible: a run whose every course refused reports zero files, `complete: true`,
and a `refused` list as long as the configuration — which is honest, and is why the list is beside
the number rather than behind a flag.

## A file whose number moved is present — added (#67)

A file's name carries its item's `position`, so one item inserted at the top of a course moves every
later name by one while nothing on disk moves: a sync never renames (ADR-0003). Held against the new
numbering, the old files are all at the wrong path. `MH2100` reported **92 missing of 95**, and
ninety-one of the ninety-two were the same file sitting at another number. Across five courses, 100
of 112 were.

That is the failure *Presence, not content* refuses below, at the largest scale this command has
produced: a red that is 99% noise trains a reader to stop looking. And the second cost is worse than
the noise, because the remedy the report prints is `npm run sync` — which downloads all of them
again under their new numbers, into a destination that only grows. Two copies of everything, no way
to tell which is current, and nothing takes it back off.

So a renumbered file **counts as present**, and is named in a `renumbered` list beside `missing`.
Three parts to it:

- **It is present because it is the file.** The bytes are on disk, under the number they were
  written with. `complete` and the exit code are about what a destination holds, and it holds this.
- **It is said out loud rather than passed over.** The numbering on disk no longer matches
  NTULearn's order, nothing here will put that back, and a reader who runs `ls` should not have to
  work out why. The list says where the file would be written today and where it actually is.
- **A guess is refused.** A file stands in for one at another number only inside the folder that
  expects it, and only where the name inside the number is that folder's alone. Two items in one
  folder may share a title — NTULearn allows it — and then the name identifies neither, so the file
  is reported missing rather than guessed at: the noise this section removes, pointed the safe way.

The limit is worth saying rather than discovering. A file left behind for an item NTULearn has
stopped returning (ADR-0003) may carry the title of one that moved, and nothing but the bytes
separates the two — which this command never reads. It is counted present, and `notCovered` says so
on every run. That is the same trade *Presence, not content* makes below, at the same odds: the
alternative it replaces called ninety-one files absent that were on disk.

This narrows *`verify` still never enumerates the destination* above, and does not drop it. The
command reads a folder's listing to answer one question about a name **NTULearn gave it** — is it
here under another number — and takes nothing else from what it sees. An entry that matches no
expected name is still invisible rather than excused, so ADR-0003's additive rule holds exactly as
it did.

What this does not settle is the numbering itself. An identity that moves is an identity that cannot
be checked, and this makes the check survive the movement rather than stopping it: a sync still
writes the new number beside the old one, because `saveAttachment` re-downloads whenever the path it
would write differs from the one it recorded. Whether the number should be the item's position at
all — against a stable id, or the position recorded in `State` at first write — reaches what a sync
writes rather than what a check reads, and is its own decision.

## Presence, not content

`verify` asks the filesystem whether a file is at the path, and nothing more. It does not compare
sizes, because NTULearn's `fileSize` is absent or wrong for embedded files often enough that a
size check would report gaps that are not there, and a report that cries wolf is one nobody runs.
It does not read `State` either: state is a cache of what a previous run believed it wrote, so a
verify that consulted it would answer from the same record that was already wrong.

## Consequences

- **A gap exits `1`.** A complete destination exits `0`. This is the red signal that means
  something, unlike a failure count that a retried transient download reddens forever.
- **It costs a session and a full read of the course.** An item that claims an attached file is
  re-read in full, exactly as a sync does, so verifying is roughly the cost of a sync that
  downloads nothing. Since #32 it also converts every body to Markdown and throws the result away,
  because whether a document is expected is decided by whether the conversion produced one. That is
  local work against a network-bound command, and it is the price of the two walks being one.
- **A renumbered file is present and named.** It counts toward `complete`, so no sync is sent to
  fix a file that is already there — and the `renumbered` list is what says the destination's order
  has drifted from NTULearn's.
- **A present file is never inspected.** A truncated, corrupt or superseded file counts as
  present. What this command detects is absence.
- **The path it predicts is the path a sync writes**, because both walk the course through
  `src/sync/expected.mjs`, which names the files a course is expected to hold and where each
  one belongs. Sharing the naming alone would not have been enough: what a walk *counts* can drift
  from what a walk *downloads* just as easily, and a folder whose own body carries an embed is
  exactly that case — no run downloads it, so nothing may expect it either. For the same reason
  that walk yields each document with the *text* a run would write rather than only its path: a
  document written conditionally is one whose expectation has to be decided by the code that
  decides the writing.
- **The report says where it stops.** A completeness number is only ever relative to the authority
  behind it, and this one's is a single read of the course, so what that read does not reach is
  part of the answer rather than a caveat on it: an item the walk never returned, an object that is
  neither attachment nor document, and a file present at the path but truncated or since replaced.
- **It reports the destination and never repairs it.** The repair is `npm run sync`, which is the
  same separation ADR-0003 draws between reporting and acting.

## Revisit when

- **A file appears that genuinely cannot be downloaded** — the case the deferred third question
  was about. Then there is something to classify, and both this command's exit code and the sync's
  are the thing to reconsider, together.
- **A folder's own body turns out to carry an attachment somebody wanted.** Today neither side
  expects it. The fix would be in the sync, which would download it, and `verify` would follow
  without being told — but it is a change to what a sync writes, so it is its own issue.
- **The number in a name stops being the item's position.** Then a name that moved is a name that
  changed, this stand-in has nothing left to stand for, and the section it belongs to goes with it.
- **A gap is found that `verify` calls present** — a truncated download, a file replaced upstream
  with different bytes. That is the argument for checking content, and it needs a real instance
  rather than the theory, because the check costs a download of everything.
- ~~**Markdown documents go missing in a way the sync does not report.**~~ This one fired: #32, and
  the second section above is what it changed.
- **An authority arrives that is not this walk.** Everything here is measured against one read of
  the course, so the walk cannot catch its own blindness — and the four gaps found so far were all
  found by a person in a browser. A second reading of the same course, from somewhere the walk does
  not go, is what would turn "everything I saw is here" into "nothing was missed" (#33).
- **A `verify` run wants to be a step in a `sync`** — for instance, one that finishes by saying
  what is still absent after it has written everything it could. That is a sync reporting on its
  own destination rather than a flag that turns its writes off, and the objection above does not
  reach it.
