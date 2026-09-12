---
description: "Retrospective Session persistence types and adjacent-release changes for dsh-v0.1.3-alpha.2."
kind: persistence-release
---

# Persistence release: dsh-v0.1.3-alpha.2

English | [中文](dsh-v0.1.3-alpha.2.zh.md)

## Summary

feedback/message-put and feedback/message-delete are added without changing the existing persistence root digests. The writer format remains 2.

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
| Source commit | [41a2cdd7e9ad5b6ddfe66fdab9217e4a79876c76](https://github.com/deepseek-harness/deepseek-harness/tree/41a2cdd7e9ad5b6ddfe66fdab9217e4a79876c76) |
| Commit date | 2026-09-07T11:45:35.000Z |
| Release page | [dsh-v0.1.3-alpha.2](https://github.com/deepseek-harness/deepseek-harness/releases/tag/dsh-v0.1.3-alpha.2) |
| Previous release | [dsh-v0.1.3-alpha.1](dsh-v0.1.3-alpha.1.md) · [source comparison](https://github.com/deepseek-harness/deepseek-harness/compare/746fc39c75c77eb7663f916002ae9e3fd9827a71...41a2cdd7e9ad5b6ddfe66fdab9217e4a79876c76) |
| Session writer version | 2 |
| Session SQLite schema | Backend absent at this tag. |
| Reconstructed inventory | 56 roots / 435 types |
| This snapshot | [dsh-v0.1.3-alpha.2.schema.json](dsh-v0.1.3-alpha.2.schema.json) |

Source evidence for the version constants:

- [`packages/core/session/src/types.ts:86`](https://github.com/deepseek-harness/deepseek-harness/blob/41a2cdd7e9ad5b6ddfe66fdab9217e4a79876c76/packages/core/session/src/types.ts#L86): `export const SESSION_FORMAT_VERSION = 2`

<a id="declaration"></a>
## Declaration

```yaml persistence-release
schemaVersion: 1
tag: dsh-v0.1.3-alpha.2
commit: 41a2cdd7e9ad5b6ddfe66fdab9217e4a79876c76
previous: dsh-v0.1.3-alpha.1
sessionFormatVersion: 2
sqliteSchemaVersion: null
changes:
  - root: event:feedback/message-delete
    before: null
    after: 3ee93b06f3a125850337602bcdf155d2538c43a5c944ec55b1b3c365152d6796
  - root: event:feedback/message-put
    before: null
    after: 3b04fde0dc763cf84fbde7b6611b3194dd56d95d0c0bf0204311640468d586e1
```

<a id="changes"></a>
## Structural changes

Detected 2 changed roots and 2 structural differences. The minimum below is calculated using current rules for comparison only; it does not assert historical compliance, migration correctness, or runtime compatibility.

| Path | Change | Current minimum |
|---|---|---|
| `event:feedback/message-delete` | `root-added` | `same-version` |
| `event:feedback/message-put` | `root-added` | `same-version` |

<a id="verification"></a>
## Verification

Extraction passed canonical-graph, root-digest, and reachable-type-digest validation, permitting the original optional `surfaceOp` only for historical surface events. The in-tree check reconstructs each tag from its predecessor and verifies before/after values, snapshot coverage, and bilingual machine declarations.

```sh
pnpm run verify-persistence-releases
```

<a id="dev-note"></a>
## Dev Note

None.
