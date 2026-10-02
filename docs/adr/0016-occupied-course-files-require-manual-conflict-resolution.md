# Occupied course files require manual conflict resolution

A sync creates an absent course artifact or accepts identical bytes; it never replaces different
occupied bytes. A differing attachment, page, announcement, overview or stand-in produces an
actionable failure and a partial receipt. The existing file stays untouched. An earlier-number
placement is occupied too: differing bytes do not cause a second copy under today's number.
Identical older placements remain compatible and stay where they are.

This partially supersedes ADR-0006's **A document is never written over a page** section and its
replacement/marker consequences: the allowance to correct a generated stand-in, or replace it with
real content, no longer applies. The marker identifies origin, not whether a student added notes.
Stand-ins and their marker remain; a real page is still retained when a release-rule read has nothing
to copy. It also supersedes ADR-0009's differing-byte fallback to today's number and its consequence
that such a file is written anyway. Its placement lookup, identical-byte reuse and folder behavior
remain unchanged. ADR-0003's refusal to delete or rename remains unchanged.

The rejected alternative is treating a generated marker, download record or fetched source as
permission to replace an occupied path. Each proves something about a past run or the upstream
source; none proves the absence of a student's annotation now. The Owner's preservation requirement
therefore takes priority over automatically refreshing generated text. Sync claims an empty name
without replacing a competing writer's bytes, rather than checking once and renaming over it.

Machine operational publications are separate: `Sync status.json`, `Last synced.md` and the separate
media workflow's status documents retain their established replacement behavior. They describe runs,
not course content, and are not places for student annotations.

## Consequences

- Upstream revisions and older generated wording may require manual comparison. The Owner chooses
  an empty destination before retrying; sync performs no automatic cleanup, renaming or rescue names.
- A valid recorded actual byte count suppresses unchanged downloads despite inaccurate upstream
  `fileSize`. A legacy record without that evidence is fetched and compared again. This is a cache
  optimization, not a checksum or freshness claim; equal-size user edits may remain skipped.
- Missing files may be acquired normally. Truncated or differing occupied files remain intact and
  produce a conflict when fetched. Receipts report the attempt; presence-based verify still proves
  neither content freshness, fidelity nor exhaustive upstream visibility.

## Revisit when

The Owner requests a separate, explicitly approved replacement operation with current byte evidence
and a recovery plan. That decision must not become an unattended sync behavior.
