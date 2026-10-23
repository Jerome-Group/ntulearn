# Offline library

Students search saved course text and attachment filenames without signing in. JSON and a private standalone reading desk use the same bounded catalogue and literal matcher.

## Sub-features

- `catalogue` lists Markdown and attachment names from selected course destinations. JSON includes snippets and encoded local file links.
- `search` matches literal substrings without case sensitivity. Exact course-key selection also ignores case. Empty queries list all material.
- `passages` retains original UTF-16 ranges and one-based code-point line/column locations, exact occurrence totals and bounded context. Whole-string lowercase handles final sigma and expanding characters.
- `receipts` exposes lifecycle, 48-hour freshness, failures, and unread categories independently of scan success.
- `desk` retains full bounded document text, editable search, native course filters, two independent plain-text readers with occurrence controls, comparison/swap, local links and explicit no-results states. Results paginate 25 per page; the unique ordered queue holds 50 pages with reorder/remove/next controls.
- `safety` excludes hidden, provenance, operational, temporary, nested symlink, and special-file paths. Bounds and failed reads are visible. Profile and state runtime overlap refuses before scanning.

## How to get to it (user POV)

- `npm run library`.
- `npm run library -- --course AB1234 --query convergence`.
- `npm run --silent library -- --html > /private/path/study-desk.html`, then open that file in a browser. Keep it private and outside course destinations.

## Driving it with drive.mjs

Preconditions: supported Node and installed dependencies. No real profile, configuration, Drive, session, or network. The helper creates two fresh synthetic destinations per invocation.

- Run `node .agents/skills/verify/scripts/drive.mjs library`.
- Read the retained responses for all-material listing, body-only search, filename search, no results, and the HTML catalogue. Partial stale receipts remain visible and do not hide material.
- Inspect original ranges for astral/dotted-I/CRLF/final-sigma text, exact occurrence totals after the 20/document and 200/search retention caps, encoded attachment URLs and JSON full-text stripping. The HTML check validates the current reader/queue shell, actual script/style CSP hashes, escaped catalogue and `connect-src 'none'`; it does not execute the controller.
- Check explicit symlink, hidden, provenance, and temporary exclusion counts. An oversized Markdown file produces exit `1` with a text omission. A nonhidden runtime overlap and missing configuration produce exit `2` with an action.
- Every invocation hashes synthetic files and records modes before and after. Require identical observations, settled children, removed fixtures, and surviving evidence.
- For browser proof, export a separate synthetic desk outside its destinations. Open a late source whose passages were omitted by the global cap and navigate its independently computed occurrences. Compare two sources, move each position, swap and preserve both positions. Filter courses, search no match and exceed the query bound; readers and queue remain. Add once/reorder/remove/next, fill the queue to 50 and reject a 51st, paginate over 25 results and reload to clear temporary state. Use named jumps, keyboard controls and 320/390-pixel layouts. Inject script-closing text; require literal reader text, no injected nodes and unchanged source hashes.
- Use a browser surface that permits the export. If only an HTTP preview is available, record that boundary and leave native file launch and attachment navigation unverified. A zero-remote-requests claim requires a complete network observation; a truncated capture is insufficient. CLI shell checks alone do not establish browser interaction proof.

## Gotchas

- JSON emits snippets. HTML contains full bounded Markdown. Both exports include private names and local file locations, while upstream course IDs remain excluded.
- Query limit is 256 code points; passage context is 70 code points per side. Matching rows remain visible when passage retention is exhausted. Reader-local search ignores the global retention budget and current course filter. At most two complete source bodies and one current mark per reader are rendered; reload clears readers/queue, with no persistent storage or network lookup.
- Exit `0` means complete local scanning, `1` partial or unavailable scanning, `2` usage, config, runtime, or platform refusal. Receipt health has its own fields.
- Root aliases are allowed. Descendant symlinks and special files are excluded without reading. Portable Node cannot guarantee an atomic snapshot under hostile concurrent ancestor replacements.
- Full NTU authentication and live course reads remain unverified and Owner-only.
- Sources: [catalogue/limits](../../../../src/library/catalogue.mjs), [search](../../../../src/library/search.mjs), [desk](../../../../src/library/html.mjs), [workspace](../../../../src/library/workspace.mjs), [CLI](../../../../src/cli.mjs), [local observation decision](../../../../docs/adr/0030-the-offline-library-is-a-bounded-local-observation.md), [workspace decision](../../../../docs/adr/0032-study-workspaces-preserve-bounded-source-context.md).
