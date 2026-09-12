---
description: "回溯 dsh-v0.1.0-rc.3 的已声明 Session 持久化类型及相邻版本变化。"
kind: persistence-release
---

# 持久化版本回溯：dsh-v0.1.0-rc.3

[English](dsh-v0.1.0-rc.3.md) | 中文

## 概述

重建的所有持久化根类型摘要均与上一个 alpha/rc 标签一致。写入格式仍为 0。

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
| 源码提交 | [90f6d5135bfa7e550e03cdb6ab7334b3f146de58](https://github.com/deepseek-harness/deepseek-harness/tree/90f6d5135bfa7e550e03cdb6ab7334b3f146de58) |
| 提交日期 | 2026-08-13T10:40:08.000Z |
| 发行页面 | 只有 tag，没有 release 对象。 |
| 前一版本 | [dsh-v0.1.0-rc.2](dsh-v0.1.0-rc.2.zh.md) · [源码比较](https://github.com/deepseek-harness/deepseek-harness/compare/c8b74bbbd6258c238fce2f60bb6b5fab8a2c1ec4...90f6d5135bfa7e550e03cdb6ab7334b3f146de58) |
| Session 写入版本 | 0 |
| Session SQLite schema | 15 |
| 完整重建清单 | 47 roots / 374 types |
| 本条快照 | [dsh-v0.1.0-rc.3.schema.json](dsh-v0.1.0-rc.3.schema.json) |

版本常量的源码证据：

- [`packages/core/session/src/types.ts:56`](https://github.com/deepseek-harness/deepseek-harness/blob/90f6d5135bfa7e550e03cdb6ab7334b3f146de58/packages/core/session/src/types.ts#L56): `export const SESSION_FORMAT_VERSION = 0`
- [`packages/session/session-persistence-sqlite/src/schema.ts:20`](https://github.com/deepseek-harness/deepseek-harness/blob/90f6d5135bfa7e550e03cdb6ab7334b3f146de58/packages/session/session-persistence-sqlite/src/schema.ts#L20): `export const SCHEMA_VERSION = 15`

<a id="declaration"></a>
## 声明

```yaml persistence-release
schemaVersion: 1
tag: dsh-v0.1.0-rc.3
commit: 90f6d5135bfa7e550e03cdb6ab7334b3f146de58
previous: dsh-v0.1.0-rc.2
sessionFormatVersion: 0
sqliteSchemaVersion: 15
changes: []
```

<a id="changes"></a>
## 结构变化

相较前一 tag，规范化的根类型及其传递引用摘要没有变化。SQLite schema 版本或后端可用性的变化仍单独记录在上方，不由这些类型摘要覆盖。

<a id="verification"></a>
## 校验

提取结果已通过规范图、根摘要和全部可达类型摘要校验；仅对历史 surface 事件允许源码原有的可选 `surfaceOp`。仓库内检查从前驱重建每个 tag，核对 before/after、快照覆盖和双语机器声明。

```sh
pnpm run verify-persistence-releases
```

<a id="dev-note"></a>
## 开发备注

无。
