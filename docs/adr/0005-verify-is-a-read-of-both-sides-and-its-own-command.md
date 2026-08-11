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

## Attachments only

The report counts attachments and names the ones that are absent. Markdown documents are written
from the snapshot on every run, so a missing document means a missing content item — which is a
different defect, in the walk rather than in a download, and one the sync itself would have to
have been blind to. The gap this answers is the file that did not arrive.

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
  downloads nothing.
- **A present file is never inspected.** A truncated, corrupt or superseded file counts as
  present. What this command detects is absence.
- **The path it predicts is the path a sync writes**, because both walk the course through
  `src/sync/attachments.mjs`, which names the files a course is expected to hold and where each
  one belongs. Sharing the naming alone would not have been enough: what a walk *counts* can drift
  from what a walk *downloads* just as easily, and a folder whose own body carries an embed is
  exactly that case — no run downloads it, so nothing may expect it either.
- **It reports the destination and never repairs it.** The repair is `npm run sync`, which is the
  same separation ADR-0003 draws between reporting and acting.

## Revisit when

- **A file appears that genuinely cannot be downloaded** — the case the deferred third question
  was about. Then there is something to classify, and both this command's exit code and the sync's
  are the thing to reconsider, together.
- **A folder's own body turns out to carry an attachment somebody wanted.** Today neither side
  expects it. The fix would be in the sync, which would download it, and `verify` would follow
  without being told — but it is a change to what a sync writes, so it is its own issue.
- **A gap is found that `verify` calls present** — a truncated download, a file replaced upstream
  with different bytes. That is the argument for checking content, and it needs a real instance
  rather than the theory, because the check costs a download of everything.
- **Markdown documents go missing in a way the sync does not report.** Then the walk extends to
  them and this record's second section is what changes.
- **A `verify` run wants to be a step in a `sync`** — for instance, one that finishes by saying
  what is still absent after it has written everything it could. That is a sync reporting on its
  own destination rather than a flag that turns its writes off, and the objection above does not
  reach it.
