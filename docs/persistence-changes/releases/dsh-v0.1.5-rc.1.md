---
description: "Retrospective Session persistence types and adjacent-release changes for dsh-v0.1.5-rc.1."
kind: persistence-release
---

# Persistence release: dsh-v0.1.5-rc.1

English | [中文](dsh-v0.1.5-rc.1.zh.md)

## Summary

All reconstructed persistence root digests match the preceding alpha/rc tag. The writer format remains 3.

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
| Source commit | [18a8c507f9f0516d835a3747582937349dd7c6e3](https://github.com/deepseek-harness/deepseek-harness/tree/18a8c507f9f0516d835a3747582937349dd7c6e3) |
| Commit date | 2026-09-10T01:36:48.000Z |
| Release page | [dsh-v0.1.5-rc.1](https://github.com/deepseek-harness/deepseek-harness/releases/tag/dsh-v0.1.5-rc.1) |
| Previous release | [dsh-v0.1.5-alpha.2](dsh-v0.1.5-alpha.2.md) · [source comparison](https://github.com/deepseek-harness/deepseek-harness/compare/9ddbf04dd310d9c29f9ab607410132e02dc5842e...18a8c507f9f0516d835a3747582937349dd7c6e3) |
| Session writer version | 3 |
| Session SQLite schema | Backend absent at this tag. |
| Reconstructed inventory | 59 roots / 462 types |
| This snapshot | [dsh-v0.1.5-rc.1.schema.json](dsh-v0.1.5-rc.1.schema.json) |

Source evidence for the version constants:

- [`packages/core/session/src/types.ts:88`](https://github.com/deepseek-harness/deepseek-harness/blob/18a8c507f9f0516d835a3747582937349dd7c6e3/packages/core/session/src/types.ts#L88): `export const SESSION_FORMAT_VERSION = 3`

<a id="declaration"></a>
## Declaration

```yaml persistence-release
schemaVersion: 1
tag: dsh-v0.1.5-rc.1
commit: 18a8c507f9f0516d835a3747582937349dd7c6e3
previous: dsh-v0.1.5-alpha.2
sessionFormatVersion: 3
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
