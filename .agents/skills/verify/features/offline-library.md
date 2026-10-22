# Offline library

Students search saved course text and attachment filenames without signing in. JSON and a private standalone reading desk use the same bounded catalogue and literal matcher.

## Sub-features

- `catalogue` lists Markdown and attachment names from selected course destinations. JSON includes snippets and encoded local file links.
- `search` matches literal substrings without case sensitivity. Exact course-key selection also ignores case. Empty queries list all material.
- `receipts` exposes lifecycle, 48-hour freshness, failures, and unread categories independently of scan success.
- `desk` retains full bounded document text, editable search, native course filters, plain-text reading, local links, and explicit no-results states.
- `safety` excludes hidden, provenance, operational, temporary, nested symlink, and special-file paths. Bounds and failed reads are visible. Profile and state runtime overlap refuses before scanning.

## How to get to it (user POV)

- `npm run library`.
- `npm run library -- --course AB1234 --query convergence`.
- `npm run --silent library -- --html > /private/path/study-desk.html`, then open that file in a browser. Keep it private and outside course destinations.

## Driving it with drive.mjs

Preconditions: supported Node and installed dependencies. No real profile, configuration, Drive, session, or network. The helper creates two fresh synthetic destinations per invocation.

- Run `node .agents/skills/verify/scripts/drive.mjs library`.
- Read the retained responses for all-material listing, body-only search, filename search, no results, and the HTML catalogue. Partial stale receipts remain visible and do not hide material.
- Check explicit symlink, hidden, provenance, and temporary exclusion counts. An oversized Markdown file produces exit `1` with a text omission. A nonhidden runtime overlap and missing configuration produce exit `2` with an action.
- Every invocation hashes synthetic files and records modes before and after. Require identical observations, settled children, removed fixtures, and surviving evidence.
- For browser proof, export a separate synthetic desk outside its destinations. Search a body-only term, read the result, filter courses, clear filters, open an attachment link, and search for no match. Use the keyboard and a narrow viewport. Inject script-closing text and verify literal reader text, no injected nodes, and no remote requests. The CLI journey alone does not establish browser interaction proof.

## Gotchas

- JSON emits snippets. HTML contains full bounded Markdown. Both exports include private names and local file locations, while upstream course IDs remain excluded.
- Exit `0` means complete local scanning, `1` partial or unavailable scanning, `2` usage, config, runtime, or platform refusal. Receipt health has its own fields.
- Root aliases are allowed. Descendant symlinks and special files are excluded without reading. Portable Node cannot guarantee an atomic snapshot under hostile concurrent ancestor replacements.
- Full NTU authentication and live course reads remain unverified and Owner-only.
- Sources: [catalogue](../../../../src/library/catalogue.mjs), [search](../../../../src/library/search.mjs), [desk](../../../../src/library/html.mjs), [CLI](../../../../src/cli.mjs), [decision](../../../../docs/adr/0030-the-offline-library-is-a-bounded-local-observation.md).
