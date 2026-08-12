# The rendered page, held against the walk

Answers one question, asked in [#45](https://github.com/Jerome-Group/ntulearn/issues/45) and run
in [#47](https://github.com/Jerome-Group/ntulearn/issues/47): if a check took the **rendered page**
as its authority on what a course holds, what would it see that a sync does not?

`docs/adr/0007` disqualifies the **body** — an item's text as NTULearn's read API returns it — and
deliberately adopts nothing in its place. The candidate it names is the rendered page, on the
strength of one course's four images: on CC0006 the body's `/sessions/…` addresses are dead and the
page serves the same files live, and all fourteen digests matched (#40). That says the page is
right *there*, on images, on one course, authored by one office. It says nothing about an embedded
player, an `<iframe>`, an `<object>`, an LTI resource, a `<video>`, a quiz or a submission point —
which is the entire population #33 is about.

So this reads nine courses both ways and prints the set difference in both directions.

## Running it

It needs a live session, so `npm run login` first. It downloads nothing and writes nowhere.

```bash
node prototype/page-vs-walk.mjs all > report.md
```

```bash
node prototype/page-vs-walk.mjs 25S2-PS0002-LAB
```

The report is Markdown on stdout, one document per run, meant to be pasted back onto #47 whole.
Progress goes to stderr. It exits `1` when the page carried an **object** the walk does not have,
or when a course could not be read at all, and `0` otherwise. An object and not a plain link: the
walk is `expectedAttachments`, so a link was never a thing it could have had, and an exit code that
went red for one would be red on every course and worth nothing.

The nine courses are configured against `.scratch/<key>/` — destinations inside this repository
rather than anybody's Drive. This program never writes to one; they are there so that #47's
spot-check has somewhere to sync a course to that is not a real destination.

## What each side is

`page-vs-walk.mjs` runs both and prints the difference. It opens two sessions in turn rather than
one, because Chrome locks the profile directory.

- **The walk** is `expectedAttachments` from `src/sync/attachments.mjs` — the same generator a sync
  downloads from and `verify` counts, called exactly as they call it. Not a copy of it: the point
  is to be checking the thing itself.
- **The rendered page** is `rendered-page.mjs`. It shares the saved session and nothing else — no
  address, no field name, no idea of the content tree. It never calls the read API, so the XSRF
  token the session hands it goes unused: a page carries the cookies, and the token is what an API
  request adds. It takes the session whole all the same, because a reader with its own quieter
  sign-in would be a second thing that can be wrong about whether the student is signed in, and
  that is the one failure this must not invent.

The reader works the way the student does. It loads the course outline in the browser, clicks open
everything that is closed, takes its item set from the links Ultra rendered, and then opens each
item's own page. On each page it reads every `<img>`, `<a>`, `<iframe>`, `<object>`, `<embed>`,
`<video>`, `<audio>`, `<source>` and `<track>` — off the DOM **properties** rather than the
attributes, so what it records is the address the browser resolved and would fetch rather than the
string an author wrote. That distinction is the whole question `docs/adr/0007` leaves open; taking
the attribute would be measuring the body again through a browser.

Ultra renders a deep-linked item inside the whole application, so the item's page carries the
navigation, the logos and the links to its siblings. Those are subtracted by harvesting the bare
outline first and dropping anything that appeared there.

## Reading the output

Per course, and both directions:

- **On the page, not in the walk** — the answer. An object here is on the student's screen and in
  no sync's expectation set, which is the #33 family. Each one is listed with the element that
  carried it and the item it was on, because *which element* says whether the walk missed a kind of
  embed or a kind of element, and those are different bugs.
- **Links on the page the walk does not have** — an `<a>` to somewhere that is not a file address.
  A link survives the Markdown conversion, so a reader still has it; this is the pile to read once,
  not a gap.
- **In the walk, not on the page** — an attachment the sync expects and no page showed. Not a
  defect on its own: an item this could not open carries objects it never counted.
- **Items that could not be read**, and **a course that could not be read**. A course is a
  **failure**, never a course with no content — the `ML0004-TUT` shape (#32) one level up, and the
  property that matters most for a run nobody watches. A course the Owner has been unenrolled from
  is deliberately in the corpus to prove it.

An object is anything embedded; a plain link is navigation. An `<a>` into `/bbcswebdav/`, a
`/sessions/` address or an `xid-` is an object however NTULearn wrote it, because that is the shape
#33 names as written without a `data-bbfile`.

## What it is not authoritative about

Stated in the report itself, every run, because a limit that lives only here is a limit nobody
reads at the moment it matters: the contents of a cross-origin frame, anything a page loads only
after a click, anything not on a content item, and anything the bare outline also carries.

## It is not merged, and that is deliberate

`docs/agents/workflow.md`: a prototype lives on a `prototype/<name>` branch off `main` and stays
there. Merged, it becomes something an agent finds and copies; deleted, it takes the evidence with
it. What lands on `main` is whatever it turns out to have proved — which is #33's ADR, not this.

`prototype/second-reader` is the one before it. That one greps the **body** for anything
file-shaped and is what produced the ten aliases `docs/adr/0007` rests on. This one never reads a
body at all, and `docs/adr/0007` predicts it will find no aliases whatsoever. A non-zero alias
count is the result worth having.
