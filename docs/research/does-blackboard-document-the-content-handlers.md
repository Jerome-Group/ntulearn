# Does Blackboard document the content handlers, and does its public API describe this surface?

**#33's option 3 is not viable: Blackboard publishes a list of nine handlers, but it is a list of
what its *public REST API* supports, the namespace it lists is open to any Building Block, and this
repository has already met two handlers that are not on it — one of them a plugin's, which no
vendor list could have contained.**

Researched 11 August 2026 against Anthology's and Blackboard's own developer and product
documentation. No NTULearn session was used and no course was read; every finding below is from a
vendor page, and where a question has no vendor answer that is recorded as the finding.

## The caveat, settled first: there are two surfaces and they are not the same document

`src/ntulearn/client.mjs` reads `/learn/api/v1/…`. **Nothing published by Blackboard describes
that path.** Searches of the developer documentation and the product help turn up
`/learn/api/public/v1/…` and nothing else; the vendor's own cookbooks, demos and SDK samples use
the public path exclusively. The internal UI API is not documented, not versioned in public, and
carries no compatibility promise — its shape is known here only because it was measured here.

So each finding below is tagged with the surface it is about. Where a claim is about the public
API, it says nothing about what `/learn/api/v1/…` returns, and the two are shown to differ in §4.

## 1. The handler list exists, is versioned, and is explicitly a *supported* set

**Surface: public REST API.** The vendor page is
[ContentHandler Data Types](https://blackboard.github.io/rest-apis/learn/advanced/contenthandler-datatypes).
It opens:

> Learn's `/contents` endpoints accommodate different types of content by using different handlers.
> Use the contentHandler field of requests and responses to indicate which content handler should
> be used. Available contentHandlers their uses are summarized below.
>
> Supported handlers include:

Nine, each with the Learn version it became available in:

| contentHandler ID | Description | Supported since |
|---|---|---|
| `resource/x-bb-document` | (Original) base document type, consists of rich text with an associated title. (Ultra) basic content item | 3000.1.0 |
| `resource/x-bb-externallink` | external link | 3000.1.0 |
| `resource/x-bb-folder` | document that has child documents | 3000.1.0 |
| `resource/x-bb-courselink` | link to a Blackboard course | 3100.5.0 |
| `resource/x-bb-forumlink` | link to a discussion object | 3100.6.0 |
| `resource/x-bb-blti-link` | link to an LTI object | 3200.6.0 |
| `resource/x-bb-file` | represents a file object within Learn | 3200.6.0 |
| `resource/x-bb-asmt-test-link` | (Ultra only) Ultra assignment or test object | 3300.5.0 |
| `resource/x-bb-assignment` | (Original only) | 3400.9.0 |

Two words carry the whole finding. **"Supported"** — this is the set the REST API handles, not the
set Learn stores. **"Since"** — the set grows, so a list read today is a list as of a release.

### The vendor says in its own words that the two sets differ

The release note *Content management: Blank page handler supported via REST API – 3900.78*
(November 2023) is the clearest statement available that a content type exists in Learn while the
handler table does not carry it:

> The blank page content type is a versatile tool. With this tool, educators can create engaging
> and interactive teaching materials. In Original courses, the blank page can incorporate files,
> images, and text as links. **But we had no supported integration with REST APIs**, creating
> inefficiencies in content management.
>
> Now, users create and organize blank pages directly from the Content REST API. We have added
> support for the blank page handler (`resource/x-bb-blankpage`).

The content type predates the handler support by years; the handler table is where support is
announced, not where the vocabulary is recorded. And `resource/x-bb-blankpage` is *still absent
from the table above* — nearly three years after the release note that added it. The page meant to
be the enumeration lags its own product.

### The namespace is open, and this repository has already met a handler from outside it

Two handlers this repository has seen are missing from the vendor's nine, and the second is fatal
to the option rather than merely awkward for it.

- **`resource/x-bb-lesson`** — a Learning Module. Absent from the table, yet the fixtures here
  carry it: `{ "resource/x-bb-lesson": { isLesson: true, isFolder: true } }` in
  `test/content.test.mjs`, and `{ "resource/x-bb-lesson": { isFolder: true } }` in
  `test/placement.test.mjs`.
  `isFolder()` in `src/ntulearn/content.mjs` exists precisely because keying on
  `resource/x-bb-folder` alone leaves a Learning Module's children unwalked. A handler this
  repository walks every sync is one the enumeration would have missed.
- **`resource/x-plugin-scormengine`** — seven items in ML0004, recorded in #33 as *"ML0004's
  actual course content… the seven topics the course is made of"*. Note the prefix. It is not
  `x-bb-`, because it is not Blackboard's core vocabulary: SCORM is a plugin, and the vendor says
  so —
  ["The SCORM Engine Building Block manages and plays Shareable Content Object (SCO)
  packages"](https://help.anthology.com/blackboard/administrator/en/tools-management/scorm-engine.html),
  and it "is bundled with Blackboard and must be made available by the administrator."

The second one settles it. A Building Block registers its own content handler under its own key, so
the handler namespace is **extensible by whatever an institution has installed**. There is no list
Blackboard could publish that enumerates it, because the set is not Blackboard's to close. No vendor
page found documents the `x-plugin-` prefix, or any convention for plugin-supplied handler keys, or
any registry of them — **recorded as absent**, and the absence is the answer.

So the premise the issue put to the test — *"the vendor documents its own vocabulary"* — is false
twice over. Blackboard documents the part of its own vocabulary its public API supports, and the
vocabulary is not only Blackboard's. **Option 3 built on this list would be complete only for the
kinds Blackboard's REST API supports on a course with no Building Blocks installed** — which is the
same defect #33 named, now sourced from the vendor instead of from eight courses.

## 2. What each handler is documented to carry — and what that is not

**Surface: public REST API.** The page documents, per handler, the *fields the handler object
carries*, not what the item holds for a reader:

- `resource/x-bb-externallink` — `id`, `url`.
- `resource/x-bb-folder` — `id`, `isBbPage` ("whether the object represents a page in its own
  right").
- `resource/x-bb-courselink` — `id`, `targetId`, `targetType` (enumerated: `Unset`,
  `CourseAssessment`, `CourseTOC`, `Forum`, `Tool`, `CollabSession` (deprecated since 3000.1.0),
  `Group`, `BlogJournal`, `StaffInfo`, `ModulePage`).
- `resource/x-bb-forumlink` — `id`, `discussionId`.
- `resource/x-bb-blti-link` — `id`, `url`, `customParameters`.
- `resource/x-bb-file` — `id` and `file` with `uploadId`, `fileName`, `mimeType`,
  `duplicateFileHandling`.
- `resource/x-bb-asmt-test-link` — `id`, `assessmentId`, `gradeColumnId`.
- `resource/x-bb-assignment` — `id`, `gradeColumnId`, `groupContent`.
- `resource/x-bb-document` — no fields. For Ultra it is described only as: "represents the body
  of an Ultra document object. It must be the child of a `resource/x-bb-folder` content item for
  which `isBbPage=true`."

**Only one of the nine documents an attachment, and it is the one this repository already reads.**
Nothing in the table says whether an item carries a body, a stream, or an embed; the handler
describes the item's *configuration*, and the payload lives elsewhere. That "elsewhere" is §3.

There is no vendor statement, anywhere found, that maps a handler to "carries an attachment / a
body / a launch link / a stream / nothing". A table of that shape does not exist. **Recorded as
absent** — which is what makes §1's finding matter: even a complete list of keys would not have
been a list of what to fetch.

## 3. The public API hands back the same HTML, and is not a student's to switch on

**Surface: public REST API.** Two findings, and the first is the decisive one.

### For Ultra, the vendor's own answer is "parse the BBML"

[Using cURL to access content attachments](https://blackboard.github.io/rest-apis/learn/examples/curl-attachments-demo)
is Blackboard's cookbook for exactly the question #33 asks. Its algorithm:

> Get children
> If folder
>   Get children
>   If document and Ultra Course parse BBML for attachment URL
> else if not Ultra Course get attachments
>   get attachment Id
>   get attachment download

And, for Ultra:

> In Ultra the URL for the attachment is embedded in the BBML for the content Item

> To access the document URL for downloading you must search the bbml and extract any href string
> that contains a content item xid

The example body it then shows is an `<a>` carrying a `bbcswebdav` href and a
`data-bbfile="{&quot;render&quot;:&quot;attachment&quot;,…&quot;linkName&quot;:…}"` attribute. That
is `attachmentsOf()` in `src/ntulearn/content.mjs`, described by the vendor, as the documented
method.
**NTULearn is Ultra, so the structured `/attachments` route documented in the same cookbook is the
Original-course branch and does not apply.** The public API therefore offers no structured
inventory of what an Ultra page holds — it hands back the same HTML, and #33's hole (an
`<iframe>`, `<object>` or `<embed>` carrying something that is not a `data-bbfile` link) is a
hole in the vendor's method too.

This is worth stating plainly because it cuts the other way as well: the regex this repository was
slightly embarrassed about is not a reverse-engineering shortcut. It is what Blackboard tells
integrators to do.

### A student cannot reach the public API alone

[3LO — Three-Legged OAuth](https://blackboard.github.io/rest-apis/learn/getting-started/3lo)
confirms an application can act as an ordinary user with that user's entitlements — "the
application is now acting as Professor X, and as such, only has access to his or her courses". But
[Rest and Learn](https://blackboard.github.io/rest-apis/learn/admin/rest-and-learn) and
[First Steps](https://blackboard.github.io/rest-apis/learn/getting-started/first-steps) put the
gate before that: the integration is registered at `developer.anthology.com` for an Application ID,
and then a **Learn administrator** must register it on the instance via *System Admin → REST API
Integrations*, associating "a Learn user account with sufficient entitlements". Nothing in the
documentation describes any route by which a user reaches the public API without that registration.

So the public API is not a cheaper read for this repository. It is an institutional request to NTU,
which is a different kind of cost than a page load, and it buys an interface that — for Ultra —
hands back the same HTML.

## 4. The fields this repository reads are mostly undocumented, and one is documented differently

**Surfaces: both, compared.** Of the five names #46 asks about:

| Field read here | In the public API's documentation |
|---|---|
| `contentHandler` | Documented, but as an **object** — `"contentHandler": { "id": "resource/x-bb-file", "file": {…} }` |
| `body.rawText` / `body.displayText` | **Not documented.** `body` is documented as a plain string |
| `contentDetail` | **Not documented at all.** No vendor page uses the name |
| `permanentUrl` | **Not documented at all.** No vendor page uses the name |

The `contentHandler` difference is structural rather than cosmetic. The public API nests the
handler's fields *inside* `contentHandler` alongside its `id`; the internal API returns
`contentHandler` as a bare string and puts the same per-handler detail in a parallel `contentDetail`
map keyed by that string — which is why `isFolder()` here reads
`Object.values(item.contentDetail ?? {})`. Neither `contentDetail` nor that layout appears in any
vendor document.

The `body` difference is the sharpest contradiction. The vendor's Ultra example returns:

> `"body" : "<!-- {\"bbMLEditorVersion\":1} --><a href=…>SOAP Deprecation Announcement.pdf</a>"`

— a string, whose content
[Creating content with REST-API](https://blackboard.github.io/rest-apis/learn/working-with-apis/creating-content)
identifies as BBML: "Body can be created using BBML". This repository reads `item.body?.rawText`
and `item.body?.displayText`, two fields of an object. **The internal API's body is a different
shape under the same name, and the vendor has documented neither the object nor the two field
names.**

The practical consequence: the public documentation cannot be used to predict a `/learn/api/v1/…`
response, and a change to the internal API would arrive without a release note. What holds this
repository together on that surface is its tests and its measurements, not a contract.

## 5. `bbcswebdav` is documented; `/sessions/<id>/…` is not

**Surfaces: public REST API and product help.**

`bbcswebdav` appears in vendor documentation in three places, and in every one it is a **signed,
expiring** address rather than a durable one:

- The Ultra body example above:
  `…/bbcswebdav/pid-435737-dt-content-rid-21916118_1/xid-21916118_1?VxJw3wfC56=1543432981&Kq3cZcYS15=…`
- The `/attachments/{id}/download` response, which is a `302` whose `Location` is
  `…/bbcswebdav/xid-21916142_1?VxJw3wfC56=…&…` — the API's own answer to "where is this file" is
  a redirect to a query-signed URL, not a stable path.
- [Content Collection](https://help.anthology.com/blackboard/administrator/en/tools-management/content-collection.html)
  documents the mechanism and its lifetime: "Signed URLs allow content to be delivered directly and
  securely from cloud storage… A signed URL is equivalent to the actual file after it's delivered
  to the browser", with a **URL Expiration Time** an administrator sets "between 180 minutes and
  1440 minutes (24 hours)".

So a `bbcswebdav` URL carrying a signature query string is documented to die on a timer of the
institution's choosing. That is a vendor-documented reason for a stored address to stop resolving,
and it is worth having; it is **not** confirmation of what `docs/adr/0007` measured. The addresses
that ADR found dead were `/sessions/<id>/…` forms and stale `rid-` ids, which is a different
failure from an expired signature. What §5 establishes is that the vendor's own model of a durable
reference is *the item*, not the URL — which is why `embeddedUrl()` in `src/ntulearn/content.mjs`
is right to ask the element's live link first, whichever of the two mechanisms killed the snapshot.

The one durable reference the product documents is the Content Collection's **Permanent URL**, and
it is an authoring feature rather than an API one: an instructor copies it from *Edit Settings* to
"add a link in your course to a file or folder in the Content Collection", and the same page notes
that overwriting a file keeps it — "If the file is linked in your course, the link remains intact
and the edits appear." That is a different thing from the `permanentUrl` this repository reads off
an attached file inside `contentDetail["resource/x-bb-file"].file`, which appears in no vendor
document (§4); the coincidence of names is not evidence that they are the same object.

**`/sessions/<id>/…` URLs: no vendor documentation found.** Nothing in the developer documentation,
the release notes or the product help mentions a session-scoped content address. `docs/adr/0007`
records these as aliases from measurement; the vendor neither confirms nor contradicts that, and
the absence is itself worth recording — an undocumented address form is one no vendor promise
covers, so treating it as a last resort, which `embeddedUrl()` already does, is the only defensible
posture.

## What this changes

- **#33's option 3 is closed.** Not because the vendor's list is short, but because the namespace
  is open: a Building Block registers its own handler key, `resource/x-plugin-scormengine` is one
  this repository already meets, and no enumeration Blackboard publishes can cover what an
  institution installed. The nine keys remain useful as a *floor* — they are real and their
  meanings are authoritative — but never as the complete set the option needed.
- **#33's underlying defect is not solved by the public API either.** For Ultra, the vendor's
  documented method is parsing the same BBML, so the `<iframe>`/`<object>`/`<embed>` hole is the
  vendor's hole too. Whatever authority #33 settles on, it will not be *"ask the documented API
  instead"*.
- **`docs/adr/0007`'s alias finding stands unchanged, on its own measurements.** The signed-URL
  expiry documented in §5 is a second, vendor-documented way for a stored address to die; it is not
  evidence about the `/sessions/<id>/…` addresses the ADR actually measured, and nothing here
  should be cited as though it were.
- **`src/ntulearn/content.mjs` is doing the documented thing, not a workaround.** Worth knowing
  before anyone proposes replacing the `data-bbfile` parse with something "more official".
- **The internal API remains uncontracted.** Nothing here makes `/learn/api/v1/…` safer; it
  confirms that the tests in `test/` are the only specification this repository has for it.

## Sources

All are Anthology's or Blackboard's own; no blog posts or forum answers were used.

- [ContentHandler Data Types](https://blackboard.github.io/rest-apis/learn/advanced/contenthandler-datatypes)
- [Using cURL to access content attachments](https://blackboard.github.io/rest-apis/learn/examples/curl-attachments-demo)
- [Creating content with REST-API](https://blackboard.github.io/rest-apis/learn/working-with-apis/creating-content)
- [First Steps with Learn REST API](https://blackboard.github.io/rest-apis/learn/getting-started/first-steps)
- [3LO — Three-Legged OAuth](https://blackboard.github.io/rest-apis/learn/getting-started/3lo)
- [Rest and Learn](https://blackboard.github.io/rest-apis/learn/admin/rest-and-learn)
- [Use APIs to Work with Ultra Assignments](https://blackboard.github.io/rest-apis/learn/advanced/ultra-assignments)
- [Content Collection (administrator)](https://help.anthology.com/blackboard/administrator/en/tools-management/content-collection.html)
- [SCORM Engine (administrator)](https://help.anthology.com/blackboard/administrator/en/tools-management/scorm-engine.html)
- *Content management: Blank page handler supported via REST API – 3900.78* — Blackboard Help
  node 46916, November 2023. The live URL now redirects to Anthology's product-documentation
  index, so it is quoted from the
  [Internet Archive's capture](https://web.archive.org/web/2024/https://help.blackboard.com/node/46916)
  of Blackboard's own page.

`docs.blackboard.com` and `docs.anthology.com` serve the same developer documentation as
`blackboard.github.io`; the GitHub Pages mirror is cited throughout because it was the one that
resolved. `developer.blackboard.com/portal/displayApi/Learn` — the API reference proper, where a
full `Content` schema would live — renders only behind a sign-in, so **the field-level claims in
§4 rest on the documentation pages and worked examples above rather than on the schema itself.**
