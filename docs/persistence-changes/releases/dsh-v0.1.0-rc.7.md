---
description: "Retrospective Session persistence types and adjacent-release changes for dsh-v0.1.0-rc.7."
kind: persistence-release
---

# Persistence release: dsh-v0.1.0-rc.7

English | [中文](dsh-v0.1.0-rc.7.zh.md)

## Summary

assistant/chunk replayState changes from unknown to an object with required response and optional blocks. The writer format remains 0.

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
| Source commit | [c091949735ca40f5267bff6c5aa14cd55d4ea8b2](https://github.com/deepseek-harness/deepseek-harness/tree/c091949735ca40f5267bff6c5aa14cd55d4ea8b2) |
| Commit date | 2026-08-17T11:03:17.000Z |
| Release page | [dsh-v0.1.0-rc.7](https://github.com/deepseek-harness/deepseek-harness/releases/tag/dsh-v0.1.0-rc.7) |
| Previous release | [dsh-v0.1.0-rc.6](dsh-v0.1.0-rc.6.md) · [source comparison](https://github.com/deepseek-harness/deepseek-harness/compare/650a3960d7494f180fd596fc32e2bfaedf2cbca8...c091949735ca40f5267bff6c5aa14cd55d4ea8b2) |
| Session writer version | 0 |
| Session SQLite schema | 15 |
| Reconstructed inventory | 47 roots / 376 types |
| This snapshot | [dsh-v0.1.0-rc.7.schema.json](dsh-v0.1.0-rc.7.schema.json) |

Source evidence for the version constants:

- [`packages/core/session/src/types.ts:56`](https://github.com/deepseek-harness/deepseek-harness/blob/c091949735ca40f5267bff6c5aa14cd55d4ea8b2/packages/core/session/src/types.ts#L56): `export const SESSION_FORMAT_VERSION = 0`
- [`packages/session/session-persistence-sqlite/src/schema.ts:20`](https://github.com/deepseek-harness/deepseek-harness/blob/c091949735ca40f5267bff6c5aa14cd55d4ea8b2/packages/session/session-persistence-sqlite/src/schema.ts#L20): `export const SCHEMA_VERSION = 15`

<a id="declaration"></a>
## Declaration

```yaml persistence-release
schemaVersion: 1
tag: dsh-v0.1.0-rc.7
commit: c091949735ca40f5267bff6c5aa14cd55d4ea8b2
previous: dsh-v0.1.0-rc.6
sessionFormatVersion: 0
sqliteSchemaVersion: 15
changes:
  - root: event:assistant/chunk
    before: 7fd942b2189b8dbf6e1a2c7b026e9ddd1e7dba3fbe5645708a76f4cddabb281d
    after: de04e4ae000cc4422a15fb86dce7c398c8a9970ac963b6f7f785e2276a939e62
```

<a id="changes"></a>
## Structural changes

Detected 1 changed roots and 1 structural differences. The minimum below is calculated using current rules for comparison only; it does not assert historical compliance, migration correctness, or runtime compatibility.

| Path | Change | Current minimum |
|---|---|---|
| `event:assistant/chunk.data.chunk.replayState` | `type-changed` | `version-bump` |

<a id="verification"></a>
## Verification

Extraction passed canonical-graph, root-digest, and reachable-type-digest validation, permitting the original optional `surfaceOp` only for historical surface events. The in-tree check reconstructs each tag from its predecessor and verifies before/after values, snapshot coverage, and bilingual machine declarations.

```sh
pnpm run verify-persistence-releases
```

<a id="dev-note"></a>
## Dev Note

None.
