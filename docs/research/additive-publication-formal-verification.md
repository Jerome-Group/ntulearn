# Why additive publication gets a bounded model

Recorded 23 October 2026 for #317. Source baseline `c9ffeb8a4b138773ade93ba72e053c9d97032186`.

[Poteto's original announcement](https://x.com/poteto/status/2111926622278521253) motivated a reusable formal skill. Direct retrieval returned HTTP 403. Search exposed an [indexed secondary summary](https://assertion.github.io/2026/10/19/ai-twitter-hots-en), not an authenticated reading of the post. No technical claim here depends on that summary.

The [upstream formal skill](https://github.com/cursor/plugins/blob/main/pstack/skills/create-formal-verification-skill/SKILL.md) requires source correspondence, explicit bounds, a broken real-code witness, and a confirmed source commit. The installed [pstack port](https://github.com/michael-denyer/pstack-claude), version 0.9.102, supplied `create-formal-verification-skill`, `maintain-formal-verification-skill`, and the Codex mapping. Those installed files were read from `/Users/jeromequeck/.codex/plugins/cache/pstack-claude/pstack/0.9.102/skills/`. Maintenance distinguishes drift from product bugs and edits verification separately.

[Official TLC documentation](https://docs.tlapl.us/using:tlc:start) describes finite-state checking and Java 11 runtime requirements. The [tools 1.7.4 release](https://github.com/tlaplus/tlaplus/releases/tag/v1.7.4) supplies the pinned jar. The runner verifies SHA-256 `936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88`; its engine reports TLC 2.19 of 08 August 2024. Distribution and engine version names differ. Local verification used Temurin 21.0.13+9. CI uses its available Java runtime and the same jar hash.

ADR-0003 rejects deletion of student work. ADR-0016 keeps occupied course bytes immutable. `writeWithoutReplacing` inspects, stages privately through `writeAtomically`, then claims the shared path with `link`. The publication order is the question that TLC answers cheaply. The model keeps `lstat` and `readFile` separate, tracks the first occupant, and distinguishes requested bytes from staged bytes. Three writers, two bodies, and five initial occupants bound the claim.

The native companion runs actual source in isolated fixtures with import-only instrumentation. It forces both writers to see absence, then A to publish before B. Replacing `link` with `rename` must change A's bytes to B's. Truncating private staging must return `true` with incomplete bytes. Corresponding model mutations must violate the named invariants. Neither a model pass alone nor a generic failing mutant is sufficient.

This design omits VM replay and graph export. The smaller runner leaves a bounded hand-model correspondence obligation, recorded in the area skill. It does not cover renumber, external path swaps, aliases, crash durability, operational replacements, or live authentication. Those need separate properties and evidence.
