---
description: "回溯 dsh-v0.1.2-alpha.3 的已声明 Session 持久化类型及相邻版本变化。"
kind: persistence-release
---

# 持久化版本回溯：dsh-v0.1.2-alpha.3

[English](dsh-v0.1.2-alpha.3.md) | 中文

## 概述

重建的所有持久化根类型摘要均与上一个 alpha 标签一致，但该标签的源码树删除了 Session SQLite 持久化包及其模式声明。写入格式仍为 0。

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
| 源码提交 | [509785f6aca108d4720325a838d54bc8ac5d841b](https://github.com/deepseek-harness/deepseek-harness/tree/509785f6aca108d4720325a838d54bc8ac5d841b) |
| 提交日期 | 2026-08-31T15:53:17.000Z |
| 发行页面 | [dsh-v0.1.2-alpha.3](https://github.com/deepseek-harness/deepseek-harness/releases/tag/dsh-v0.1.2-alpha.3) |
| 前一版本 | [dsh-v0.1.2-alpha.2](dsh-v0.1.2-alpha.2.zh.md) · [源码比较](https://github.com/deepseek-harness/deepseek-harness/compare/76ae850c165f8561232bf7ff212773ab248043b5...509785f6aca108d4720325a838d54bc8ac5d841b) |
| Session 写入版本 | 0 |
| Session SQLite schema | 此 tag 没有该后端。 |
| 完整重建清单 | 54 roots / 417 types |
| 本条快照 | [dsh-v0.1.2-alpha.3.schema.json](dsh-v0.1.2-alpha.3.schema.json) |

版本常量的源码证据：

- [`packages/core/session/src/types.ts:51`](https://github.com/deepseek-harness/deepseek-harness/blob/509785f6aca108d4720325a838d54bc8ac5d841b/packages/core/session/src/types.ts#L51): `export const SESSION_FORMAT_VERSION = 0`

<a id="declaration"></a>
## 声明

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
