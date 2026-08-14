# A failed download stays red, and a permanent one inherits the refused shape

A download that fails reddens the exit code, on every run, for as long as it keeps failing. Nothing
classifies a failure as permanent, nothing counts how often it has recurred, and nothing is written
down about it between runs — `sync` in `src/cli.mjs` stays exactly as it reads today, returning `1`
where any course reports a failure.

That is a decision rather than a deferral. **Supersedes `docs/adr/0005`'s section *What a permanent
failure does to the exit code is left open*.** Everything else in that record stands, including the
refused-course section this one leans on.

And it comes with a default, which is the half that makes the question closeable: **when a file that
genuinely cannot be fetched does turn up, it takes the shape a refused course already has** — named
in the report, said out loud in `notCovered`, and not reddening the exit code — rather than getting
a mechanism of its own. `docs/adr/0005` decided that for a course in #66.

That transplant has an objection, and #28 makes it against itself before anyone else could:

> A closed course is permanent *by construction* — NTULearn says `403` and the student is not
> enrolled, so no further evidence is needed. A file that 404s is only *presumed* permanent, and
> #26 is the reason to distrust that presumption. The two are not the same kind of fact, and the
> course-level answer leans entirely on the difference.

The objection is right, and it is why only the **shape** is transplanted and not the test. What
makes a course eligible for that shape is the by-construction fact, and nothing here says a status
code is one. So a file becomes eligible when somebody can show it is permanent the way a closed
course is — not when it 404s — and defining that is deferred to the instance, deliberately. The
shape is safe precisely because the gate in front of it is unbuilt.

## The question, and why three months did not produce the evidence

#21 raised it from ten failures that looked like NTULearn's — `404`s, and at least one `403` on a
`/sessions/…` address. #25 found they were ours: `embeddedUrl` preferred the `data-bbfile` snapshot
over the element's own live link, and all ten served their file from the element. Since then
thirteen courses report **885 of 885 present, `complete: true`, exit `0`**, and #67 removed the
renumbering false-positives that were the last thing polluting the missing list.

So the population of genuinely unfetchable files is, as far as anyone here can measure, **zero** —
the same shape `docs/adr/0011` found for the embedded object, and the same discipline applies. A
permanence rule built now would be built against a case nobody can produce, which is guessing at its
shape.

**That number is the tool agreeing with itself, and #33 filed a whole issue about why that is weak:
"a green report is a better hiding place for this defect than a red one ever was."** It is cited
here for the one thing it can honestly carry — that nobody has *met* an unfetchable file — and not
as proof that none exists. Which is the same reason this record builds nothing: an argument from
absence is strong enough to decline a mechanism and far too weak to design one.

## The three alternatives, and what each would cost

**Count runs rather than statuses** — a failure seen in N consecutive runs stops counting. The cost
is not the counting, it is that there is nowhere to keep the answer. `CONTEXT.md` defines *State* as
"a cache and never a source of truth: losing it costs time and nothing else", so a permanence mark
kept there re-reddens on the next machine and after every cache clear. The alternative is a new file
in the destination, which `docs/adr/0007` refused on its own grounds: "the destination gains no
artefact that goes stale." Either way this option is a change to one of those two records rather
than a change to the exit code. `docs/adr/0007` refused an HTML copy of a page rather than any file
whatever, but its grounds reach this: an artefact derived from what one run saw, which
`docs/adr/0003` then means nothing ever corrects. It also decides permanence from history rather than from the file,
so a fortnight of NTULearn being down marks files permanent that were never broken.

**Classify the response** — a named set of statuses and destinations that mean "not coming". The
cheapest to build and the one with the worst failure mode, because what it builds is a rule for
*suppressing an alarm*. #25 is the precedent and it is exact: ten failures were read as permanent
and upstream, and were our own stale pointer. A classifier would have silenced them. Both failures
this repository has attributed to NTULearn — #19 and #25 — turned out to be its own, which makes
"trust our reading of a status enough to stop reporting" the one inference the evidence forbids.

**Move the signal off the exit code** — let `verify` answer completeness and stop a sync's exit code
carrying failures. This is backwards for what the tool is becoming. A scheduled run nobody watches
has its exit code as the only channel a monitor reads, and under this option a run that failed to
download forty files exits `0` — the silence #17 through #33 were spent removing. It also re-couples
the two commands `docs/adr/0005` separated on purpose.

## Why the red is not the thing the issue feared

The objection to a permanent red is real and this record accepts it: an exit code that is always `1`
is one nobody reads, and it masks the transient reds that do have a remedy. That is
`docs/adr/0005`'s own sentence about a refused course.

What makes it survivable here is that a red is **self-correcting evidence**. If a permanently
unfetchable file exists, the runs go red and stay red, and that is precisely the reproducible
instance this question has been waiting for since #21. The failure mode of doing nothing is that the
tool tells you about the thing it needs you to look at. The failure mode of options 2 and 3 is that
it stops telling you, on the strength of a reading of NTULearn this repository has been wrong about
three times.

## Consequences

- **A permanently failing file would redden every run until somebody looks.** That is the accepted
  cost, and it is bounded by the fact that nobody has produced one. If it happens on a scheduled
  run, the schedule is noisy until the instance is examined — which is the work this decision wants
  doing anyway.
- **`State` keeps its meaning.** It stays a cache that can be deleted with no consequence but time,
  which is what lets a destination be rebuilt on another machine.
- **Nothing new is written to a destination.** `docs/adr/0003` and `docs/adr/0007` are untouched.
- **A failure and a refusal are now deliberately different.** A refused course does not redden
  because there is no remedy to point at; a failed download does, because there usually is, and
  because the remedy has so far been a fix in this repository. The asymmetry is the decision, not an
  oversight.
- **The default above is a promise about design, not code.** No mechanism exists for a permanent
  file failure and none is built here. What is fixed is that the first person to meet one does not
  have to reopen the argument — they apply `docs/adr/0005`'s refused shape.

## Revisit when

- **A file appears that genuinely cannot be fetched, established in the real UI.** Opened in
  NTULearn in a browser and confirmed not to render there either — every "upstream" claim here that
  skipped that step was wrong. Then the default above is applied, and the thing to decide is only
  what makes a file eligible for it.
- **A red run stops being read.** If the scheduled sync goes red often enough that the signal is
  ignored, the objection has become real regardless of whether any single failure is permanent, and
  the answer is triage of what reddens rather than a permanence rule.
- **Something durable arrives in a destination for another reason.** The blocker on option 2 is that
  there is nowhere to write a mark. `docs/adr/0007`'s *Revisit when* already names one way that
  could change; if it does, option 2 becomes cheap and this record should be re-read rather than
  assumed.
