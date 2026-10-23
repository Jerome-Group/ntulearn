# Study workspaces preserve bounded source context

The offline library keeps a whole-document reading workspace with two distinct sources and a
temporary ordered queue. It extends the bounded local observation in [ADR-0030](0030-the-offline-library-is-a-bounded-local-observation.md).
Reading, comparison, and queue changes belong to one browser state owner. Encoded local file URLs
identify sources within that export. Search and course changes preserve the open sources and queue.

A snippet alone cannot support studying a passage in its original context. The shared literal matcher
therefore returns original-source ranges and locations, plus exact occurrence and omission counts.
Whole-string lowercase matching preserves contextual casing. A sparse walk maps folded hits back to
complete original code points, because expanding characters such as dotted I change offsets. Context
retains original whitespace. UTF-16 ranges agree with JavaScript slicing; code-point columns remain
readable when the source contains astral characters. CRLF counts as one line break.

Rendering every occurrence or document would make common queries expensive to inspect. A search
retains 20 passages per document and 200 overall while counting later matches. It keeps every matching
material record. Readers search their selected document independently, so an earlier source cannot
consume another reader's navigation budget. Result pagination and one current mark per reader bound
the DOM separately from the catalogue. Full Markdown remains HTML-only; JSON adds bounded passages
without changing schema version, matching-material counts, file links, or scan exits.

The queue holds 50 unique readable pages. Native controls reorder and remove entries; opening a page
does not consume it. Reload clears the queue. Persistent queues would require ownership, stale-source
handling, and storage rules across exports. The temporary queue avoids those costs while supporting a
reading session. Attachments and omitted Markdown remain explicit local-file links rather than
pretending their contents are available for comparison.

## Consequences

- Catalogue order favors earlier passages in JSON and result previews. Exact omission counts expose
  this bound, and opening a page restores its own navigation budget.
- Comparison keeps two independent plain-text sources. It makes no claim that their passages are
  equivalent or that either source is current upstream.
- The export retains inert JSON and exact script/style CSP hashes. Supplied text enters the DOM as
  text nodes. There is no parser, session, network, server, index, browser storage, or destination write.
- Partial scans, omitted text, and receipt health remain separate observations. An open reader does
  not strengthen any of that evidence.

## Revisit when

Students need navigation beyond the retained passages in one document, or a persistent reading plan
whose ownership and stale-source rules can be stated without granting new authority over course files.
