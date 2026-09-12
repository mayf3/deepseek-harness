---
description: "Retrospective Session persistence types and adjacent-release changes for dsh-v0.1.2-rc.1."
kind: persistence-release
---

# Persistence release: dsh-v0.1.2-rc.1

English | [中文](dsh-v0.1.2-rc.1.zh.md)

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
| Source commit | [d4eb4f46bcffa29a98c1157d57bac0519cddaea5](https://github.com/deepseek-harness/deepseek-harness/tree/d4eb4f46bcffa29a98c1157d57bac0519cddaea5) |
| Commit date | 2026-09-03T02:35:15.000Z |
| Release page | [dsh-v0.1.2-rc.1](https://github.com/deepseek-harness/deepseek-harness/releases/tag/dsh-v0.1.2-rc.1) |
| Previous release | [dsh-v0.1.2-alpha.5](dsh-v0.1.2-alpha.5.md) · [source comparison](https://github.com/deepseek-harness/deepseek-harness/compare/b1f658abda3abebdcc2a2aa3727c2615b0857e8b...d4eb4f46bcffa29a98c1157d57bac0519cddaea5) |
| Session writer version | 0 |
| Session SQLite schema | Backend absent at this tag. |
| Reconstructed inventory | 54 roots / 415 types |
| This snapshot | [dsh-v0.1.2-rc.1.schema.json](dsh-v0.1.2-rc.1.schema.json) |

Source evidence for the version constants:

- [`packages/core/session/src/types.ts:87`](https://github.com/deepseek-harness/deepseek-harness/blob/d4eb4f46bcffa29a98c1157d57bac0519cddaea5/packages/core/session/src/types.ts#L87): `export const SESSION_FORMAT_VERSION = 0`

<a id="declaration"></a>
## Declaration

```yaml persistence-release
schemaVersion: 1
tag: dsh-v0.1.2-rc.1
commit: d4eb4f46bcffa29a98c1157d57bac0519cddaea5
previous: dsh-v0.1.2-alpha.5
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
