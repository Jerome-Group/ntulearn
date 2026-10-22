# The offline library is a bounded local observation

`library` derives a catalogue from configured destinations and emits JSON or a self-contained HTML
reading desk to stdout. It reads Markdown and attachment filenames. Receipts describe sync attempts
separately from scan success. State and source provenance confer no library authority. Retained files
and annotations remain searchable without claiming upstream completeness or a current source revision.

A persistent index would need invalidation, ownership, and recovery rules. A local server would need
a process and a browser access boundary. A bounded in-memory catalogue avoids both costs and lets the
same literal matcher power JSON and browser search. HTML keeps Markdown as plain text to avoid a
parser dependency and prevent course HTML, links, or images from executing or loading automatically.
Generated local file links require an explicit user action. CSP hashes permit only the fixed script
and stylesheet. The export contains private text and locations, so the Owner keeps it outside course
destinations. Shell redirection happens before the command and cannot be governed by this reader.

Traversal excludes hidden, provenance, operational, temporary, nested symlink, and special-file paths.
Profile and state runtime overlap refuses the catalogue before content reads. Root aliases are allowed
after canonical metadata checks. Bounded no-follow handles qualify regular files and reject observed
changes. Portable Node cannot exclude every hostile concurrent ancestor swap between path operations.
This command observes a stable local tree; it does not promise a filesystem sandbox or atomic snapshot.

## Consequences

- Every invocation rescans within published limits. Oversized directories are skipped whole and
  oversized or invalid UTF-8 Markdown remains findable by filename with an omission diagnostic.
- Safe exclusions are counted. Unavailable reads and exhausted bounds make the scan partial. Receipt
  health remains independent. A stale or absent receipt cannot hide useful material.
- There is no writer, network, session, browser dependency, or attachment parser in the library route.
  Existing receipt and Academic OS contracts remain unchanged.

## Revisit when

Representative destinations repeatedly exceed the bounds, or the Owner requires atomic traversal
under hostile filesystem mutation. The latter requires descriptor-relative native traversal rather
than further path checks.
