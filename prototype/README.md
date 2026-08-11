# A second reader for what the walk never sees

Answers one question, asked in [#29](https://github.com/Jerome-Group/ntulearn/issues/29): when
`npm run verify -- all` says `complete: true`, is the number it counted to the right number?

`verify` checks its **numerator** against the world — for every attachment it expects, it asks the
filesystem whether a file is there. Its **denominator** is the tool's own opinion: attachments as
`src/ntulearn/content.mjs` reads them. If that reader misses a kind of embed, the sync never
downloads it and `verify` never expects it, and both shrug in unison. Every denominator bug found
so far — #17, #19, #22, #25/#26 — was found by opening NTULearn in a browser and looking.

So this reads each course a second time, sharing no code with the walk, and prints the set
difference in both directions.

## Running it

It needs a live session, so `npm run login` first. It downloads nothing and writes nothing.

```bash
node prototype/compare.mjs all
node prototype/compare.mjs CC0006
```

It exits `1` when the second reader found something file-shaped that the walk did not, and `0`
otherwise. Progress goes to stderr and the report to stdout, so `> report.json` keeps the report.

## What each side is

`compare.mjs` runs both and prints the difference. It opens two sessions in turn rather than one,
because Chrome locks the profile directory.

- **The walk** is `src/sync/attachments.mjs` — the same generator a sync downloads from and
  `verify` counts, called exactly as they call it. Not a copy of it: the point is to be checking
  the thing itself.
- **The second reader** is `second-reader.mjs`, and it imports nothing from
  `src/ntulearn/content.mjs`. It is dumber than the walk on purpose, in three places where the walk
  knows something it might be wrong about:
  - it asks **every** item for children, where the walk descends only into what `isFolder` says is
    a container — which is the shape #17 had;
  - it re-reads **every** item in full, where the walk re-reads only what `isFile` says has a file
    attached;
  - it greps **every string** of the item, where the walk reads named fields of the body — for
    anything file-shaped (`/bbcswebdav/`, `xid-`), for an `href` or `src` pointing back at
    NTULearn, and for whatever a `data-bbfile` carries inside it.

It shares the session, because a blind transport is not the failure mode in question. It does not
share the address.

## Reading the output

Per course, and both directions:

- **`missedByTheWalk.fileShaped`** — the answer. Anything here is an attachment the sync never
  downloads and `verify` never counts, which is a bug of the #26 family and gets its own issue.
- **`missedByTheWalk.other`** — a link back at NTULearn that is not obviously a file. Mostly pages
  and course links; the pile to read once.
- **`missedByTheReader`** — what the walk expects and the grep did not find. Not a defect on its
  own: the walk re-reads an item in a way this does not, so a difference here is worth
  understanding rather than fixing.
- **`unreadable`** — an item that answered with an error. A course with many of these has not been
  read, and the difference for it means less than it looks like.

## It is not merged, and that is deliberate

`docs/agents/workflow.md`: a prototype lives on a `prototype/<name>` branch off `main` and stays
there. Merged, it becomes something an agent finds and copies; deleted, it takes the evidence with
it. What lands on `main` is whatever it turns out to have proved.

If it is worth running repeatedly, that is a separate proposal argued on its own — and it would be
a different program, because this one costs a request per item and re-reads the whole course.
