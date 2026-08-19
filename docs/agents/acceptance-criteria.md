# Acceptance criteria, ticking, and the drift block

An issue's acceptance criteria are the checkboxes under its **Acceptance criteria** heading. They
are what the ticket asked for, in a form a reader who did not write it can check. This file says
what an agent does with them when it finishes.

## 0. A criterion states a property of the work, not the state of the tracker

This comes before the three below because it is about **writing** a criterion rather than
discharging one, and it is where the only failure the practice has produced actually lives.

A criterion is read by a session that is not the one that wrote it, and often days later. Anything
in it that describes *the tracker* — which issues are open, who will settle something next — is true
when written and can be false when read. Anything that describes *the work* stays true.

The failure that named this rule was an ADR follow-up carrying:

> - [ ] It states that General's address is **#81's and #80's**, and does not decide it.

Both were open when that was written and closed by the time it was worked, so obeying it literally
would have written *"pending #81"* into a record ADR-0001 makes **immutable**. The criterion it
should have been is the same sentence with the tracker taken out:

> - [x] It **does not decide** General's address.

That one never goes stale. The record still does not decide it, and a reader wanting to know who did
follows the record's own links.

**Citing a settled decision is fine, and common** — *"records the line #35 drew"*, *"records why
#7's recommendation was reversed"*. A closed ticket's finding is a fact about the work. Of the seven
such citations measured when this was written, six had aged perfectly; the one that had not cited a
question rather than an answer.

**The test:** if the criterion would have to be rewritten because a ticket closed, it is describing
the tracker. Move that part into the issue's prose, where it is context rather than an instruction.

Three further obligations, in the order they come up. An issue with no criteria — a Decision, whose
output is a decision record rather than a checklist — owes the first two nothing and the third all
of it.

All three are checked rather than remembered: the conformance workflow reads every pull request
against the issue it closes and goes red on an unexplained box, a missing drift block or an issue
that never got its labels (ADR-0035). Write them as you go and the check never has anything to
say.

## 1. Tick what you delivered, on the issue

Before you stop, edit the issue body: every criterion you satisfied is ticked, and every one you
did not is left unticked. `gh issue edit <n> --body-file -` with the edited body, or the web
checkbox — either is fine, both write the same thing.

Ticking is a claim about the code, not about the effort. A criterion is ticked when the thing it
describes is true in the branch, and not when you tried.

## 2. Never tick a box you did not deliver

An unachievable criterion is a **first-class outcome**, not a failure to hide. It is declared by
an explicit not-doing line in the pull-request body, in this shape:

> **Not doing — #40, "`bin/audit` asserts the ruleset's bypass list":** the provider does not read
> bypasses back, so there is nothing to assert against without a raw API call, which is its own
> ticket.

Issue, criterion, reason — all three, because the line has to be readable by someone who has not
opened the issue. A pull request that leaves a box unticked and says nothing about it is
incomplete; one that leaves it unticked and says why is finished.

The rule this replaces is the one worth naming: nothing here is ever served by ticking a box
falsely in order to merge. What the Owner loses when that happens is not the criterion — it is
the knowledge that a criterion could not be met, which is usually the most valuable thing the
session produced.

## 3. Report the drift

The **drift block** is a fixed shape, and it appears twice: in the agent's final message and in
the pull-request body. Fixed rather than free-form for the same reason the labels are declared
rather than remembered — a free-form block is present sometimes and absent sometimes, and that
variance is the thing being removed.

It leads with a verdict, so the Owner can act on it without reading a list of things that went
right:

> **#40 — Audit the branch-protection baseline: 6 of 7 criteria delivered, plus one thing you
> didn't ask for.**
>
> ⬜ **Not delivered** — `bin/audit` asserts the ruleset's bypass list. The provider does not read
> bypasses back; it would take a raw API call, which is its own ticket. **Say the word and I'll
> file it.**
> ➕ **Beyond the brief** — `bin/audit` now names the repository in every failure line. Half the
> new assertions are per-repository and the old output did not say which one failed. **Say the
> word and I'll take it out.**
>
> Everything else is ticked on the issue and in the PR.

Only two kinds of line ever appear in it: **Not delivered** and **Beyond the brief**. What went to
plan is on the issue as a ticked box and needs no second copy. Both kinds end in an explicit
offer, so the Owner's next move is one word.

When there is nothing to report, it collapses to a single line and is still present:

> **#40 — Audit the branch-protection baseline: 7 of 7 criteria delivered, nothing beyond the
> brief.**

## The review runs before the pull request opens

`/code-review` runs on the finished branch, **before** the pull request is opened — which is where
the implement skill already places it — so the drift block is written after the review rather than
before it. ADR-0029 argues the order; what it means in practice is that a review finding is fixed
in the branch, and the block reports the branch as reviewed.

The pull request itself is not optional — **How work flows** in `AGENTS.md` is that rule.
