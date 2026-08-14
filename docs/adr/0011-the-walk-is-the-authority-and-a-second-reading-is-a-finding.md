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

**2. The rendered page.** Refused as *the* authority by #47, on nine courses, for three independent
reasons: it produced **nine aliases** against `docs/adr/0007`'s prediction of zero; it is **not a
superset of the walk**, losing 45 attachments, 5 SCORM packages and 1 LTI placement while reporting
nothing wrong; and it costs a page load per item, which on the largest course ran long enough to
trip NTULearn's own idle-logout.

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
surface.

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
They exist because a script ran. No read of NTULearn's content API can ever hold them, and the
rendered page holds them only as addresses with expiring tokens on them. The thing behind them — the
recording — is already reachable by the walk: as an anchor in the body, or as the
`resource/x-bb-externallink` item `externalLinkOf` reads. On `25S1_SLAC03` the bodies carry 5
Kaltura and 7 YouTube addresses directly.

Recorded lecture videos and their transcripts are a known missing feature (`README.md`, *Status*)
and are out of this issue's scope by its own words. So most of this population is that feature
wearing a different hat.

Strip the player output, the furniture and the *aliases*, and what is genuinely unaccounted for
across five courses is a handful of external links and one LTI launch iframe.

**The authority was never the gap.** The walk sees the items, the bodies, the attachments and the
links. What it does not see is what a player generates after it starts, and that is not a defect in
which reading of a course is trusted.

## Why the rendered page is not adopted as a routine second channel either

#47's own verdict argues for the page as a second, disagreeing channel whose output is a finding.
That is right about what it is good for and this record still does not schedule it, for three
reasons that only apply to *routine* use:

- **It costs a second read of the course** — a page load per item, roughly 277 across the configured
  courses. `docs/adr/0005` already prices the first read; this doubles it.
- **Its signal-to-noise is a report nobody would trust.** On five courses it named 246 page-only
  objects, of which 9 were aliases, 36 furniture and 116 things no sync could bring across. A
  channel that names 246 things and means one is the report `docs/adr/0005` refuses on the grounds
  that a report nobody trusts is one nobody runs.
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

Relative to the walk it is close to true today, and what it costs to say so is naming the two places
it is not:

- **An address the walk holds and never fetches.** An anchor in a body, or an external link. It
  survives into the Markdown as a link, so nothing is hidden from the student — but it is in none of
  the three states, because none of them is about an address that was never a download.
- **A body element the strip removes.** Population zero on the corpus above, and zero is not none.
  The strip is silent by construction: if a body ever does carry an `<iframe>`, nothing anywhere
  will say it was removed.

Both are named here rather than fixed, because this record's whole finding is that the second was
about to be fixed against nothing.

## Consequences

- **Nothing under `src/` changes because of this record.** `sync` reads what it read, `verify`
  counts what it counted, and `complete: true` keeps exactly the meaning `README.md` already gives
  it. A decision that changes no code is still a decision: what it buys is that the next session to
  reach for one of the three options finds them measured rather than open.
- **The walk's blind spots are named rather than suspected.** What it cannot see is what a script
  produces after a page loads, and one LTI launch iframe. That is a smaller and more specific
  statement than the one this issue opened with, and it is falsifiable on the next course that
  disagrees.
- **Most of this issue is absorbed by a feature that does not exist yet.** If recorded lecture
  videos are taken on, ~91 of the 92 unaccounted-for objects stop being a question about authority
  and become a question about reaching a Kaltura entry id.
- **The strip in `src/sync/markdown.mjs` stays silent.** Turning it into a tripwire — record the
  element rather than delete it without a word — is cheap, pure and testable, and it is not this
  record's to build. It is worth having precisely because its expected yield is zero: the run that
  fires it is the run that falsifies the measurement above.
- **The second reading is not free and is not gone.** Running the page reader is a session's work
  and a session's cost, and its output is a finding for a human. Anything that schedules it is
  reopening this record rather than following it.
- **A report names its authority.** `README.md` already carries the list of what `complete: true`
  does not cover, and `verify` already prints `notCovered` on every run (#37). This record supplies
  the name that list was missing.

## Revisit when

- **A course is met whose body carries an `<iframe>`, `<object>` or `<embed>`.** One instance moves
  the population off zero and takes this record's central measurement with it. That is what the
  tripwire above would be for.
- **Recorded lecture videos are taken on.** Most of the gap is that feature, and the question stops
  being which reading of a course to trust.
- **A player's output stops being reachable another way.** Today every recording found has an anchor
  or an external-link item behind it. A course where the only trace of a video is script output is a
  course the walk genuinely cannot see, and then the rendered page is the only channel that can.
- **A Building Block is installed that renders its content only in the page.** SCORM was the first
  handler nobody's list contained; the next one may not put its address in a body at all.
- **The scheduled run gets a watchdog that reads what it prints.** Two of the three objections to
  the page as a routine channel are about a report nobody reads and a session nobody is watching. A
  run whose findings are durable rather than printed prices it differently — which is the shape
  `docs/adr/0007` already predicted this pressure would take.
