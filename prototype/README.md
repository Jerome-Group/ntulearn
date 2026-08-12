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
every folder and scrolls every list to its end, takes its item set from the links Ultra rendered,
and then opens each item's own page. It asks each of those pages what *it* links to as well, so a
folder that renders as its own page is still reached.

Both halves of that were measured rather than assumed. On PS0002 the unscrolled, unexpanded outline
offers 3 items; expanding gets 27; scrolling as well gets 43, and the walk has 90 attachments
across exactly those 43. Everything from `Tutorial & Lab 9` onwards is simply not in the DOM until
the list has been scrolled to it.

On each page it reads two things off every element. The DOM **property** first — `src` as a
property is the address the browser resolved and would fetch, where the attribute is the string an
author wrote, and whether those two differ is the question `docs/adr/0007` leaves open. Then every
attribute, because on Ultra the property alone finds nothing: a course's attached file renders as

```html
<a data-ally-file-preview-url="…/bbcswebdav/pid-5569511-…/xid-58395685_1" style="display: none;"></a>
```

with **no `href` at all**, and the preview control beside it carries the same address in an
`aria-controls`. An element-shaped reader walks past every attachment in the course — the run that
proved it had 90 attachments in the walk and *zero* addresses in common with the page.

This is still the rendered page and not the body. What is read is the DOM Ultra built out of the
body, after it resolved it; the attribute sits on an element that exists only because the page ran.

**The application is subtracted twice.** Ultra renders a deep-linked item inside the whole of
itself, so an item's page carries the navigation, the notification socket, the Ally client and the
LTI placements. An address is treated as furniture if the bare outline also carried it, or if
*every* item carries it and it is not shaped like a file. `<script>` and `<link>` are skipped
outright: they are how Ultra arrives, never a course's object. Without those three rules the same
course reported 111 page-only objects, and every one of them was Blackboard loading itself.

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
after a click, anything not on a content item, a `data:` address, and whatever the two furniture
rules subtract.

Scrolling is not a click, and the difference is the line this draws. A page that renders more when
it is scrolled is rendering what is already there; a page that renders more when it is clicked is
being asked for something. So the outline is scrolled and clicked open, and an item's page is only
ever scrolled — its `aria-expanded` controls are file previews, and sweeping those would make this
reader fetch things the student never asked for.

## What one course has shown so far

`25S2-PS0002-LAB`, the only course this has been run against: **43 items, 90 attachments in the
walk, all 90 also on the page.** Nothing the walk expects is missing from the page, and the three
addresses the page has that the walk does not are Zoom's LTI error assets. **No aliases**, which is
what `docs/adr/0007` predicts and what #47 exists to test properly.

One course is not the answer to anything — it is the same mistake #29 made, and `docs/adr/0007`
says so in as many words. It is recorded here because it is what the calibration cost.

## It is not merged, and that is deliberate

`docs/agents/workflow.md`: a prototype lives on a `prototype/<name>` branch off `main` and stays
there. Merged, it becomes something an agent finds and copies; deleted, it takes the evidence with
it. What lands on `main` is whatever it turns out to have proved — which is #33's ADR, not this.

`prototype/second-reader` is the one before it. That one greps the **body** for anything
file-shaped and is what produced the ten aliases `docs/adr/0007` rests on. This one never reads a
body at all, and `docs/adr/0007` predicts it will find no aliases whatsoever. A non-zero alias
count is the result worth having.
