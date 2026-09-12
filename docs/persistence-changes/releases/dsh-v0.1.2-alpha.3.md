---
description: "Retrospective Session persistence types and adjacent-release changes for dsh-v0.1.2-alpha.3."
kind: persistence-release
---

# Persistence release: dsh-v0.1.2-alpha.3

English | [中文](dsh-v0.1.2-alpha.3.zh.md)

## Summary

All reconstructed persistence root digests match the preceding alpha tag, but the Session SQLite persistence package and its schema declaration are removed from the tagged tree. The writer format remains 0.

## Table of Contents

- [Release evidence](#evidence)
- [Declaration](#declaration)
- [Structural changes](#changes)
- [Verification](#verification)
- [Dev Note](#dev-note)

-----

<a id="evidence"></a>
## Release evidence

This approximate backfill supports reading and format validation; it is not a contemporaneous compatibility acknowledgement. See the [archive reference](README.md) for extraction and coverage limits.

| Item | Recorded value |
|---|---|
| Source commit | [509785f6aca108d4720325a838d54bc8ac5d841b](https://github.com/deepseek-harness/deepseek-harness/tree/509785f6aca108d4720325a838d54bc8ac5d841b) |
| Commit date | 2026-08-31T15:53:17.000Z |
| Release page | [dsh-v0.1.2-alpha.3](https://github.com/deepseek-harness/deepseek-harness/releases/tag/dsh-v0.1.2-alpha.3) |
| Previous release | [dsh-v0.1.2-alpha.2](dsh-v0.1.2-alpha.2.md) · [source comparison](https://github.com/deepseek-harness/deepseek-harness/compare/76ae850c165f8561232bf7ff212773ab248043b5...509785f6aca108d4720325a838d54bc8ac5d841b) |
| Session writer version | 0 |
| Session SQLite schema | Backend absent at this tag. |
| Reconstructed inventory | 54 roots / 417 types |
| This snapshot | [dsh-v0.1.2-alpha.3.schema.json](dsh-v0.1.2-alpha.3.schema.json) |

Source evidence for the version constants:

- [`packages/core/session/src/types.ts:51`](https://github.com/deepseek-harness/deepseek-harness/blob/509785f6aca108d4720325a838d54bc8ac5d841b/packages/core/session/src/types.ts#L51): `export const SESSION_FORMAT_VERSION = 0`

<a id="declaration"></a>
## Declaration

```yaml persistence-release
schemaVersion: 1
tag: dsh-v0.1.2-alpha.3
commit: 509785f6aca108d4720325a838d54bc8ac5d841b
previous: dsh-v0.1.2-alpha.2
sessionFormatVersion: 0
sqliteSchemaVersion: null
changes: []
```

<a id="changes"></a>
## Structural changes

Normalized root types and their transitive digests are unchanged from the preceding tag. SQLite schema-version or backend-availability changes remain separately recorded above and are not covered by these type digests.

<a id="verification"></a>
## Verification

Extraction passed canonical-graph, root-digest, and reachable-type-digest validation, permitting the original optional `surfaceOp` only for historical surface events. The in-tree check reconstructs each tag from its predecessor and verifies before/after values, snapshot coverage, and bilingual machine declarations.

```sh
pnpm run verify-persistence-releases
```

<a id="dev-note"></a>
## Dev Note

None.
