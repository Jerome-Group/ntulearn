# Counting the course files a body links and nothing describes

Answers the count [#78](https://github.com/Jerome-Group/ntulearn/issues/78) asks for **before** the
change it is about: across the configured courses, how many bodies carry a `/bbcswebdav/` address
on an `<a>` or an `<img>` with **no `data-bbfile`** — and how many of those addresses are the item's
own attachment wearing a second address rather than a file nothing downloads.

## Why this is a count first

#77 tried to write the note straight from a Turndown rule in `src/sync/markdown.mjs`, keyed on "a
`/bbcswebdav/` address with no `data-bbfile`", and was refused review. `docs/adr/0011` records why:

> `attachmentsOf` also yields the item's `contentDetail` file, whose address is a `/bbcswebdav/` one
> that never appears on the anchor — so a body linking a file the sync *did* download would have
> been given a note saying it had not been.

`docs/adr/0006` refuses a false sentence on disk and `docs/adr/0003` means nothing would ever take
one back off, so the note has to be written where the **item** is in hand. That settles *where*. It
does not settle *whether*: `docs/adr/0011` measured the embedded-object population at zero across
178 bodies and measured nothing about this one, and **a note beside every ordinary inline image
would be a regression rather than a tripwire**. Only a count tells those apart.

## Running it

It needs a live session, so `npm run login` first — which makes it the Owner's to run (`AGENTS.md`).
It downloads nothing, writes nothing to any destination, and touches no sync state.

```bash
node prototype/count-undescribed.mjs all
```

Progress goes to stderr and the report to stdout, so `> count.json` keeps the report. It exits `0`
whatever it finds: a non-zero population is the thing being measured, not a failure.

## What it does

`count-undescribed.mjs` is the session around it and `undescribed.mjs` is the count itself, split
so the counting can be run against items written by hand rather than only against NTULearn.

Per item, it asks `client.readAttachments` for **exactly** the attachments a sync would download —
the same call `src/sync/expected.mjs` makes, so a file item whose Summary omitted its attachment is
re-read here too. Then it scans the HTML surfaces the conversion writes for `<a>` and `<img>`
elements, and sorts every `/bbcswebdav/` address carrying no `data-bbfile` into three:

- **`ownAttachment`** — the address is one the sync downloads, character for character. A note here
  is the false sentence #77 would have written.
- **`ownAttachmentOtherAddress`** — a different address for the same file, matched on its `xid-`.
  The same false sentence, reached the way `docs/adr/0011` predicts it would be.
- **`undescribed`** — neither. This is the population the ticket is about.

It is deliberately **wider than the walk** in one place: `src/ntulearn/content.mjs` reads only
double-quoted attributes, and this reads both quote styles. A measurement that shares the walk's
blind spot cannot report on it.

## Reading the output

- **`bodies.withUndescribed`** — the headline. How many bodies would gain a note at all.
- **`addresses.undescribedByElement`** — the regression signal. Heavy on `img` means the proposed
  note lands beside ordinary inline images, which is the outcome the ticket names as worse than
  doing nothing. Heavy on `a` means it lands beside links to files, which is what it is for.
- **`addresses.ownAttachment` + `ownAttachmentOtherAddress`** — how wrong #77 would have been. Zero
  here would mean the refusal was theoretical; anything above zero is the sentence on disk.
- **`addresses.onUnwrittenSurfaceOnly`** — addresses on the body surface the conversion does *not*
  write. Counted apart because no note would ever reach them, however the rule is written.
- **`addresses.otherNtulearnLinks` / `externalLinks`** — links to another page of the course, and
  links out. Both must stay at nothing, and these are what makes that measured rather than asserted.
- **`undescribed`** — the addresses themselves, with the item and element each sat on, so the
  population can be read rather than only counted.
- **`unreadable`** — a course that refused. Its absence from the totals is a gap, not a zero.

## It is not merged, and that is deliberate

`docs/agents/workflow.md`: a prototype lives on a `prototype/<name>` branch off `main` and stays
there. Merged, it becomes something an agent finds and copies; deleted, it takes the evidence with
it. What lands on `main` is whatever it turns out to have proved — here, the count on #78, and then
either the note or the record that the population did not want one.
