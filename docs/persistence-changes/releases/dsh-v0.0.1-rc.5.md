---
description: "Retrospective Session persistence types and adjacent-release changes for dsh-v0.0.1-rc.5."
kind: persistence-release
---

# Persistence release: dsh-v0.0.1-rc.5

English | [中文](dsh-v0.0.1-rc.5.zh.md)

## Summary

All reconstructed persistence root digests match the preceding alpha/rc tag. The writer format remains 0.

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
| Source commit | [a2e8739f4b1a508133af371e55a2827fec862cd5](https://github.com/deepseek-harness/deepseek-harness/tree/a2e8739f4b1a508133af371e55a2827fec862cd5) |
| Commit date | 2026-08-12T22:18:58.000Z |
| Release page | Tag only; no release object. |
| Previous release | [dsh-v0.0.1-rc.4](dsh-v0.0.1-rc.4.md) · [source comparison](https://github.com/deepseek-harness/deepseek-harness/compare/af88f0e21a315c3f134fc5da41caa1610acf02ac...a2e8739f4b1a508133af371e55a2827fec862cd5) |
| Session writer version | 0 |
| Session SQLite schema | 15 |
| Reconstructed inventory | 47 roots / 374 types |
| This snapshot | [dsh-v0.0.1-rc.5.schema.json](dsh-v0.0.1-rc.5.schema.json) |

Source evidence for the version constants:

- [`packages/core/session/src/types.ts:56`](https://github.com/deepseek-harness/deepseek-harness/blob/a2e8739f4b1a508133af371e55a2827fec862cd5/packages/core/session/src/types.ts#L56): `export const SESSION_FORMAT_VERSION = 0`
- [`packages/session/session-persistence-sqlite/src/schema.ts:20`](https://github.com/deepseek-harness/deepseek-harness/blob/a2e8739f4b1a508133af371e55a2827fec862cd5/packages/session/session-persistence-sqlite/src/schema.ts#L20): `export const SCHEMA_VERSION = 15`

<a id="declaration"></a>
## Declaration

```yaml persistence-release
schemaVersion: 1
tag: dsh-v0.0.1-rc.5
commit: a2e8739f4b1a508133af371e55a2827fec862cd5
previous: dsh-v0.0.1-rc.4
sessionFormatVersion: 0
sqliteSchemaVersion: 15
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
