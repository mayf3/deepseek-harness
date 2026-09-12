---
description: "Retrospective Session persistence types and adjacent-release changes for dsh-v0.1.1-rc.1."
kind: persistence-release
---

# Persistence release: dsh-v0.1.1-rc.1

English | [中文](dsh-v0.1.1-rc.1.zh.md)

## Summary

permission/preset gains optional origin with default, selection, and inferred values. The writer format remains 0.

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
| Source commit | [9a439af233a1d2e346cf9430a815b371782964e0](https://github.com/deepseek-harness/deepseek-harness/tree/9a439af233a1d2e346cf9430a815b371782964e0) |
| Commit date | 2026-08-21T06:21:44.000Z |
| Release page | [dsh-v0.1.1-rc.1](https://github.com/deepseek-harness/deepseek-harness/releases/tag/dsh-v0.1.1-rc.1) |
| Previous release | [dsh-v0.1.0-rc.8](dsh-v0.1.0-rc.8.md) · [source comparison](https://github.com/deepseek-harness/deepseek-harness/compare/fcbad141407d3a9dc9e382768eb24187953f4f46...9a439af233a1d2e346cf9430a815b371782964e0) |
| Session writer version | 0 |
| Session SQLite schema | 17 |
| Reconstructed inventory | 51 roots / 407 types |
| This snapshot | [dsh-v0.1.1-rc.1.schema.json](dsh-v0.1.1-rc.1.schema.json) |

Source evidence for the version constants:

- [`packages/core/session/src/types.ts:56`](https://github.com/deepseek-harness/deepseek-harness/blob/9a439af233a1d2e346cf9430a815b371782964e0/packages/core/session/src/types.ts#L56): `export const SESSION_FORMAT_VERSION = 0`
- [`packages/session/session-persistence-sqlite/src/schema.ts:18`](https://github.com/deepseek-harness/deepseek-harness/blob/9a439af233a1d2e346cf9430a815b371782964e0/packages/session/session-persistence-sqlite/src/schema.ts#L18): `export const SCHEMA_VERSION = 17`

<a id="declaration"></a>
## Declaration

```yaml persistence-release
schemaVersion: 1
tag: dsh-v0.1.1-rc.1
commit: 9a439af233a1d2e346cf9430a815b371782964e0
previous: dsh-v0.1.0-rc.8
sessionFormatVersion: 0
sqliteSchemaVersion: 17
changes:
  - root: event:permission/preset
    before: 5c45bf4c544a7211dcd8ba6ba7e5f1bc39b49e7a9df9d5cbdc8e87c22771b37b
    after: 7271e4b771406aaf06014c2269edd6cb68055bb8b8686571730813ce0ababc22
```

<a id="changes"></a>
## Structural changes

Detected 1 changed roots and 1 structural differences. The minimum below is calculated using current rules for comparison only; it does not assert historical compliance, migration correctness, or runtime compatibility.

| Path | Change | Current minimum |
|---|---|---|
| `event:permission/preset.data.origin` | `optional-property-added` | `same-version` |

<a id="verification"></a>
## Verification

Extraction passed canonical-graph, root-digest, and reachable-type-digest validation, permitting the original optional `surfaceOp` only for historical surface events. The in-tree check reconstructs each tag from its predecessor and verifies before/after values, snapshot coverage, and bilingual machine declarations.

```sh
pnpm run verify-persistence-releases
```

<a id="dev-note"></a>
## Dev Note

None.
