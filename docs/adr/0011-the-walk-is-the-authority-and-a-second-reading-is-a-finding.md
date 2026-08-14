# The walk is the authority, and a second reading is a finding

The reading of a course this repository trusts is **the walk**: NTULearn's content-item tree as
`src/ntulearn/` reads it, with each item's *body*, its *attachments* and its external link. A sync
takes its input from the walk and `verify` counts against it — exactly as both do today — and a
report that carries a number names it. **No second reading of a course is adopted**: not the
*rendered page*, not a harder parse of the *body*, not an enumeration of the *content handlers*.
Where a second reading is run, what it produces is a **finding**, and a finding never becomes part
of what a sync expects.

This settles the question `docs/adr/0007` deliberately left open. The surprising half is that
nothing under `src/` changes because of it, and the measurements are why: all three replacements
were tried and all three lost, and the population they were going to rescue turns out to be
something else.

## The three candidates were measured, not argued

**1. The full content-item read, for every item rather than only for file items.** Refused: it is
identical to what is already read. `?expand=gradebookCategory`, one request per item — the read
`readAttachments` already makes for a file item "because the Summary view omits an attached file" —
returns the same bodies as `@view=Summary` on `25S1_SLAC03`:

| | items with a body | bodies carrying `<iframe>`, `<object>`, `<embed>`, `<video>`, `<audio>`, `<source>` or `<track>` |
| --- | --- | --- |
| `@view=Summary` | 61 of 142 | **0** |
| full read | 61 of 142 | **0** |

Not one item gained anything. This is the option the issue called cheap and half-implemented; it is
cheap, and it is also nothing.

**2. The rendered page.** Refused as *the* authority by #47, which attempted nine courses and could
read five — the other four were closed or in Original Course View — for three independent reasons:
it produced **nine aliases** against `docs/adr/0007`'s prediction of zero; it is **not a superset of
the walk**, losing 45 attachments, 5 SCORM packages and 1 LTI placement while reporting nothing
wrong; and it costs a page load per item, which on the largest course ran long enough to trip
NTULearn's own idle-logout.

The aliases carry a qualification worth keeping, because it is what `docs/adr/0007` got right: all
nine arrive on a `data-bbfile` **attribute**, and that record's narrower claim — that what the
browser *resolves and fetches* is the live address — survived the run intact. It falsifies the
record only because a reader on the page **must** read attributes to see an Ultra attachment at all,
and inherits the stored addresses the moment it does.

**3. Enumerating the content handlers.** Refused by #46, and not for the reason it was doubted. The
doubt was that a vendor list would be short. The finding is that **no vendor list can exist**: what
Blackboard publishes is what its *public* REST API supports, a *Building Block* registers handlers
of its own, and the institution decides what is installed
(`docs/research/does-blackboard-document-the-content-handlers.md`). `resource/x-plugin-scormengine`
is already a member of that class.

## The hole this issue names is empty

The issue's mechanism is that `src/sync/markdown.mjs` strips `iframe`, `object` and `embed` from a
body the tool already holds, so an object in those forms is deleted from the student's copy as well
as absent from the expectation set.

It does strip them. There are none there to strip. Across `25S1_SLAC03`, `25S2-CC0003-LEC-ALL` and
`25S2-PS0002-LAB` — **178 bodies** — there is not one of those elements in any body, on either
surface. Three courses rather than the whole corpus, which is the limit this measurement carries and
the thing that would falsify it.

This is worth recording precisely because the fix it invites is obvious: parse the embeds before
stripping them. That fix would have been built, tested and merged against a population of zero, and
it would have closed the issue without touching anything the issue is about.

## What is actually in the gap

#47 found **92 objects** in none of the three states this issue demands. Sorted by where they come
from:

| origin | count |
| --- | --- |
| Kaltura player output — `playManifest` `.m3u8` streams, caption `track`s carrying expiring `ks` tokens, thumbnails | 64 |
| YouTube player output — `embed` frames, `ytimg` posters, channel avatars | 27 |
| plain external links, and one `blti/launchLink` iframe | ~6 |

**Roughly 91 of the 92 are the runtime exhaust of two video players**, not distinct course content.
They exist because a script ran, so what NTULearn's content API returns is the address the player
starts *from* rather than the stream, the poster and the caption track it goes on to write — and the
rendered page holds those only as addresses with expiring tokens on them. The thing behind them —
the recording — is already reachable by the walk: as an anchor in the body, as the `data-bbfile` a
player's embed carries, or as the `resource/x-bb-externallink` item `externalLinkOf` reads. On
`25S1_SLAC03` the bodies carry 5 Kaltura and 7 YouTube addresses directly.

Recorded lecture videos and their transcripts are a known missing feature (`README.md`, *Status*)
and are out of this issue's scope by its own words. So most of this population is that feature
wearing a different hat.

Strip the player output, the furniture and the *aliases*, and what is genuinely unaccounted for
across five courses is a handful of external links and one LTI launch iframe.

**The authority was never the gap.** The walk sees the items, the bodies, the attachments and the
links. What it does not see is what a player generates after it starts, and that is not a defect in
which reading of a course is trusted.

## Why the rendered page is not adopted as a routine second channel either

#47 hands this record two things, not one: a verdict against the page as *the* authority, and an
argument **for** it as a second, disagreeing channel — *"the 116 not-copyable and 85 walk-missed
objects, and above all the 92 with no state… a genuine finding."* That argument is accepted. What
this record declines is only the next step, scheduling it, for three reasons that apply to *routine*
use and to nothing else:

- **It costs a second read of the course** — a page load per item, roughly 277 across the eight
  courses configured when that was measured, and thirteen are configured now. `docs/adr/0005`
  already prices the first read; this doubles it.
- **Its output needs a human before it means anything.** On five courses it named 246 page-only
  objects: 9 aliases, 36 furniture, 116 things no sync could bring across, 85 the walk misses of
  which 77 survive as anchors anyway. Sorting those buckets is what made #47 worth reading, and the
  sorting is not automatable — telling an alias from a gap means fetching the address, which the
  reader does not do. Scheduled, it emits 246 lines a week that nobody has time to sort, which is
  the report `docs/adr/0005` refuses on the grounds that a report nobody trusts is one nobody runs.
- **It logs the session out.** This repository is aimed at unattended, scheduled runs. A channel
  slow enough to raise NTULearn's *"Are you still there?"* dialog, which neither reader reports, is
  a channel that can end the run it was meant to check.

What it keeps is the use it earned: **run it by hand against a course suspected of hiding
something.** The reader stays where `docs/agents/workflow.md` puts a prototype, on
`prototype/rendered-page-reader`, and each time it runs it produces a finding for a human to read.

## The three states hold, relative to the authority

> Every object the authority finds ends in exactly one of three states — **copied**, a **classified
> failure**, or a **recorded reason it is not copyable**. Never a fourth state of *not seen*.

Adopted, with the qualification `docs/adr/0007` makes unavoidable: it holds **with respect to what
the authority saw**, and never in general. There is no absolute completeness here, and a number that
claimed one would be claiming what nothing in this repository can measure.

Relative to the walk it was close to true when this record was written, and it named two places it
was not. One of them is now the third state and the other is still open:

- **A body element the conversion removes** — closed by #77. An `<iframe>`, `<object>` or `<embed>`
  used to be deleted from the student's copy without a word. It now leaves a line where it sat,
  naming what it was and the address it pointed at. Population zero on the corpus above, so this
  writes nothing today: it is a **tripwire**, and the run that fires it is the run that falsifies
  the measurement this record rests on. `script`, `style` and `form` are still removed in silence,
  because they carry nothing a student wants.
- **An address the walk holds and never fetches** — still open. An anchor into `/bbcswebdav/`
  carrying no `data-bbfile` is a course file `attachmentsOf` cannot see. #77 tried to write it down
  in the same place and was refused review, for a reason worth recording here: **the conversion
  layer has no item.** `attachmentsOf` also yields the item's `contentDetail` file, whose address is
  a `/bbcswebdav/` one that never appears on the anchor — so a body linking a file the sync *did*
  download would have been given a note saying it had not been. `docs/adr/0006` refuses a false
  sentence on disk, and `docs/adr/0003` means nothing would ever take it back off. Doing it honestly
  means the item's own attachments reaching the conversion, and its population is unmeasured, which
  is the thing this record exists to refuse building against.

Neither changes what is downloaded, counted or verified. A note is a *finding*, which is exactly
what this record says a second reading produces: the authority is still the walk, and the
expectation set is still the walk's alone.

One state does move, on a population currently measured at zero. An item whose body is *only* an
embedded object used to convert to nothing, and so was an *uncopied item* with a stand-in document;
it now converts to the note, so it is a page. That is the right answer — the item did carry
something — and `src/sync/expected.mjs` calls the same `contentDocument` a sync does, so what
`verify` expects moves with it rather than drifting from it.

## Consequences

- **Nothing about what is read changes because of this record.** `sync` reads what it read,
  `verify` counts what it counted, and `complete: true` keeps exactly the meaning `README.md`
  already gives it. What the record buys is that the next session to reach for one of the three
  options finds them measured rather than open. The one thing it did move is what a *page* says
  about an object nobody can bring across, which is a sentence in a document rather than anything
  in the expectation set (#77).
- **The walk's blind spots are named rather than suspected.** What it cannot see is what a script
  produces after a page loads, and one LTI launch iframe. That is a smaller and more specific
  statement than the one this issue opened with, and it is falsifiable on the next course that
  disagrees.
- **Most of this issue is absorbed by a feature that does not exist yet.** If recorded lecture
  videos are taken on, ~91 of the 92 unaccounted-for objects stop being a question about authority
  and become a question about reaching a Kaltura entry id.
- **A destination gains a sentence where an object used to vanish.** The conversion no longer
  removes an `<iframe>`, an `<object>` or an `<embed>` in silence (#77), and `docs/adr/0003` means
  a note it writes is never taken back off — so a body that carries one leaves a line in that
  folder for good, even if NTULearn later stops carrying it. That is the same cost `docs/adr/0006`
  already accepted for an uncopied item, paid on a population currently measured at zero.
- **The second reading is not free and is not gone.** Running the page reader is a session's work
  and a session's cost, and its output is a finding for a human. Anything that schedules it is
  reopening this record rather than following it.
- **A report names its authority.** `README.md` already carries the list of what `complete: true`
  does not cover, and `verify` already prints `notCovered` on every run (#37). This record supplies
  the name that list was missing.

## Revisit when

- **A course is met whose body carries an `<iframe>`, `<object>` or `<embed>`.** One instance moves
  the population off zero and takes this record's central measurement with it. The tripwire is what
  says so: a `> **Not copied**` line anywhere in a destination is this bullet firing (#77).
- **Recorded lecture videos are taken on.** Most of the gap is that feature, and the question stops
  being which reading of a course to trust.
- **A player's output stops being reachable another way.** Today every recording found has an anchor
  or an external-link item behind it. A course where the only trace of a video is script output is a
  course the walk genuinely cannot see, and then the rendered page is the only channel that can.
- **A Building Block is installed that renders its content only in the page.** SCORM was the first
  handler nobody's list contained; the next one may not put its address in a body at all.
- **A SCORM package turns out to be fetchable.** #33 left that open and it stays open: the vendor
  documents a player rather than a file, so the honest state today is the third one — a recorded
  reason it is not copyable. Answering it needs a live session against ML0004, which is the Owner's
  to run, and a yes would move seven of that course's topics from the third state to the first.
- **The scheduled run gets a watchdog that reads what it prints.** Two of the three objections to
  the page as a routine channel are about a report nobody reads and a session nobody is watching. A
  run whose findings are durable rather than printed prices it differently — which is the shape
  `docs/adr/0007` already predicted this pressure would take.
