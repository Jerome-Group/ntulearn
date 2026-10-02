# Transcript formatting preserves source wording

A *formatted transcript* changes presentation while preserving ordered source words, spelling,
case, numbers, symbols and code-switching. Punctuation, paragraph breaks and Markdown emphasis
or list markers are permitted only within that boundary. Formatting never invents headings,
speakers, transitions or notation; spoken mathematics remains spoken wording.

This partially supersedes [ADR-0014](0014-recordings-use-a-separate-media-workflow.md)'s allowance
to correct non-semantic errors and convert unambiguous notation in its formatting paragraph.
Source preservation, separate derivatives, segment timestamps retained in the source, local
models, no translation or summarization, and the workflow and storage decisions still stand.

Correcting an apparent recognition error from transcript text alone cannot establish what was
spoken or whether meaning survived. The tempting alternative asks the formatter to repair
spelling, grammar or mathematics and then treats fluency as evidence of correctness. A mandatory
lexical guard rejects those changed words or symbols instead. Instructions must respect that
boundary rather than ask for edits the guard will discard. Lexical checks themselves do not prove
semantic equivalence or acoustic fidelity, and a changed prompt proves no model-quality or
fallback-rate improvement.

## Consequences

Spelling, grammar, recognition errors and uncertain spoken mathematics remain in the derivative
until an explicitly authorized source annotation or correction is independently validated.
Unsupported formatter edits preserve source wording and report a limitation. This can be less
polished, but reading convenience cannot silently become a source correction.

## Revisit when

An independently checked correction procedure ties authorized corrections to source evidence and
validates their meaning. That procedure requires its own decision and evidence before relaxing
the formatting boundary or its mandatory guards.
