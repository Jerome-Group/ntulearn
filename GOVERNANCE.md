# Governance

Jerome Group has **one Owner**, who decides everything. This document exists because that fact
is worth stating plainly rather than leaving a contributor to infer it from silence, and because
the two mechanisms that keep a solo owner honest are worth writing down.

## Who decides

The Owner, `@jerome-queck`. There is no committee, no vote, and no lazy consensus — those are
solutions to a problem this organisation does not have. A contributor's influence comes from the
argument in the issue thread, and that turns out to be most of what a review process is for
anyway.

Repository access comes in exactly two shapes: an **outside collaborator** granted access to one
repository, or nothing. Organisation membership is a paid seat and is not how contribution
works here.

## The two constraints on the Owner

A single decision-maker fails in two specific ways — decisions get forgotten, and changes get
made without anyone looking. Both are addressed mechanically rather than by good intentions.

**Decisions are recorded, with their reasoning.** Anything that settles *how* something should
be done becomes an architecture decision record in that repository's `docs/adr/`, stating the
decision, why it was taken, and what it costs. Not a changelog — a changelog says what changed,
an ADR says why the alternative was rejected. This is what stops a decision from being silently
reversed six months later by the same person who made it.

**Changes go through a pull request, including the Owner's.** The default branch of every
repository blocks direct pushes and force-pushes, requires a pull request, requires a linear
history, and requires every review comment to be resolved. Zero approvals are required, because
a required approval with one maintainer is theatre. A repository additionally requires its CI
check to pass, once it has one worth requiring — that part is per repository, because a required
check that does not exist protects nothing.

The Owner holds a break-glass bypass on those rules. It exists so a misconfigured rule cannot
lock the organisation out of its own repositories, and using it for convenience would defeat the
point of writing this down.

## Changing this

The organisation's configuration — these rules included — lives as code in a private management
hub and is applied from there. To argue for a change, open an issue on the repository it affects
and say what should be different and why. If the answer is a decision rather than a change, it
becomes an ADR.
