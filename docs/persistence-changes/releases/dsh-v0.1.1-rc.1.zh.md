---
description: "回溯 dsh-v0.1.1-rc.1 的已声明 Session 持久化类型及相邻版本变化。"
kind: persistence-release
---

# 持久化版本回溯：dsh-v0.1.1-rc.1

[English](dsh-v0.1.1-rc.1.md) | 中文

## 概述

permission/preset 新增可选字段 origin，可取 default、selection 或 inferred。写入格式仍为 0。

## 目录

- [发行来源](#evidence)
- [声明](#declaration)
- [结构变化](#changes)
- [校验](#verification)
- [开发备注](#dev-note)

-----

<a id="evidence"></a>
## 发行来源

这是供阅读和格式校验的近似回填，不是当时的兼容性确认。提取方法和覆盖限制见[归档说明](README.zh.md)。

| 项目 | 记录值 |
|---|---|
| 源码提交 | [9a439af233a1d2e346cf9430a815b371782964e0](https://github.com/deepseek-harness/deepseek-harness/tree/9a439af233a1d2e346cf9430a815b371782964e0) |
| 提交日期 | 2026-08-21T06:21:44.000Z |
| 发行页面 | [dsh-v0.1.1-rc.1](https://github.com/deepseek-harness/deepseek-harness/releases/tag/dsh-v0.1.1-rc.1) |
| 前一版本 | [dsh-v0.1.0-rc.8](dsh-v0.1.0-rc.8.zh.md) · [源码比较](https://github.com/deepseek-harness/deepseek-harness/compare/fcbad141407d3a9dc9e382768eb24187953f4f46...9a439af233a1d2e346cf9430a815b371782964e0) |
| Session 写入版本 | 0 |
| Session SQLite schema | 17 |
| 完整重建清单 | 51 roots / 407 types |
| 本条快照 | [dsh-v0.1.1-rc.1.schema.json](dsh-v0.1.1-rc.1.schema.json) |

版本常量的源码证据：

- [`packages/core/session/src/types.ts:56`](https://github.com/deepseek-harness/deepseek-harness/blob/9a439af233a1d2e346cf9430a815b371782964e0/packages/core/session/src/types.ts#L56): `export const SESSION_FORMAT_VERSION = 0`
- [`packages/session/session-persistence-sqlite/src/schema.ts:18`](https://github.com/deepseek-harness/deepseek-harness/blob/9a439af233a1d2e346cf9430a815b371782964e0/packages/session/session-persistence-sqlite/src/schema.ts#L18): `export const SCHEMA_VERSION = 17`

<a id="declaration"></a>
## 声明

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
## 结构变化

检测到 1 个根类型变化、1 项结构差异。下表的最低要求按当前规则计算，只用于比较；不表示旧版本曾遵守这些规则，也不证明迁移或运行时兼容性。

| 路径 | 变化 | 当前最低要求 |
|---|---|---|
| `event:permission/preset.data.origin` | `optional-property-added` | `same-version` |

<a id="verification"></a>
## 校验

提取结果已通过规范图、根摘要和全部可达类型摘要校验；仅对历史 surface 事件允许源码原有的可选 `surfaceOp`。仓库内检查从前驱重建每个 tag，核对 before/after、快照覆盖和双语机器声明。

```sh
pnpm run verify-persistence-releases
```

<a id="dev-note"></a>
## 开发备注

无。
