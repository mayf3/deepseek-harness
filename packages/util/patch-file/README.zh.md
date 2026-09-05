---
description: "Loader 补丁列表文件：cordis.patch.yml 各层共用的解析器，以及带锁、原子替换与回读的、保留注释的键级写入器。"
kind: "package-reference"
---

# @deepseek-ai/dsh-patch-file

[English](README.md) | 中文

## 概述

`dsh-patch-file` 拥有 harness 每一个组合层所使用的文件格式：一个 `cordis.patch.yml` 是 Loader 补丁条目的顶层 YAML 序列——按 id 定位的覆盖（如 `disabled: true` 或替换 `config`）与插入新行的 `insert` 列表——采用 Loader 自己的方言，其中 `!!js` 标量是由该行 fiber 求值的表达式。`parsePatchList` 是 profile launcher、组合包层、`--patch` 覆盖层与 agent preset 用户层共用的唯一解析器，因此其中一方接受的文件所有人都接受。`PatchDocument` 在键级编辑这样的文件，同时保留作者写下的注释、空行与 `!!js` 标量；`mutatePatchFile` 在跨进程写锁下提交一次编辑，经原子替换落盘，并在报告结果前把写入的文本经解析器回读，告诉调用方每个读者此后会加载到什么。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

用 `parsePatchList`（已有文本）或 `readPatchListFile`（文件不存在时读到 `undefined`）读取一个补丁层。两者都把 `insert` 行中相对的名字（如 `./plugin.js`）锚定到文件自己的目录，并对任何不是"映射序列"的内容直接报错，因为一个完全无法施加的补丁文件就是配置错误；而目标行不存在的单条补丁仍然只是 Loader 的逐条警告。

通过 `mutatePatchFile` 写入。回调拿到一个 `PatchDocument`，按 Loader 寻址行的方式以行 id 编辑：

```ts
import { mutatePatchFile } from '@deepseek-ai/dsh-patch-file'

const file = '/home/me/.dsh/profiles/web/cordis.patch.yml'
await mutatePatchFile(file, (document) => {
  document.setRowField('tool-web', 'disabled', true)      // the id-targeted patch is created when absent
  document.deleteRowField('tool-web', 'config')           // a patch reduced to its id is removed whole
  document.appendInsert({ id: 'tool-foo', name: 'dsh-tool-foo' })          // into the root list
  document.appendInsert({ id: 'sql', name: 'dsh-sql' }, 'agents')          // into the group with that id
  document.removeInsert('tool-foo')                       // an emptied insert patch is removed whole
}, { binName: 'dsh', mode: 0o600, dirMode: 0o700 })
```

`setRowField` 永远不接受 `id` 与 `insert`；`rowField` 读回一个键，`!!js` 标量以其源文本返回。`appendInsert` 拒绝文件已插入的 id；`insertedRow`/`removeInsert` 也能找到插入组内部的行。写入的值都是普通数据；别的键上的 `!!js` 标量原样不动，这正是用户层能撤回自己写的 `disabled: true` 而不惊动组合包在另一行上的 `!!js` 门的原因。

`mutatePatchFile` 像 `dsh-atomic-write` 一样占用 `<file>.lock` 兄弟文件，读取文件（不存在按空处理），施加编辑，在文本有变化时以声明的权限位原子替换文件，然后返回从写入文本重新读出的补丁列表。什么都没改的编辑什么都不写。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内幕——点击展开</summary>

### 两个解析器，一种方言

读取用 `js-yaml` 配 include 的 `entryListSchema`，于是 `!!js` 标量成为 Loader 插值的表达式节点，与 include 挂载时完全一致。写入用 `yaml` 包保留注释的 `Document`：它在所修饰的标量上保留未解析的 `!!js` 标签（报告为 `TAG_RESOLVE_FAILED` 警告而非错误）并原样打印回去，因此对一个键的编辑绝不会改写另一个键的表达式。写出的文本再用读取解析器解析一遍，这就是写入器契约承诺的回读。

### 寻址

按 id 定位的补丁是 `id` 匹配且不带 `insert` 的顶层项。插入的行在每个 `insert` 列表中查找，并递归进入插入的组（`group: true` 且带 `config` 列表）。顶层项不是映射，或 `insert` 的值不是列表，都会让解析失败。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `parsePatchList`、`readPatchListFile`、`anchorInsertedPluginNames`、`PatchDocument`、`mutatePatchFile` |
| — | 不发布运行时不变量伴随件；本包不持有运行时状态，其文件契约由单元测试钉住。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当问题在于这种文件格式在组合中的位置时，读这些。

- [App boot](../../boot/app-boot/README.zh.md)——从这些文件组合组合包层、用户层与覆盖层的 profile launcher。
- [Cordis include 插件](../../../vendor/include/README.md)——`applyEntryPatches`，每一层施加时所用的补丁语义。
- [Agent presets](../../preset/agent-presets/README.zh.md)——以此格式书写的每预设用户层。

-----

<a id="model-experience"></a>
## 模型体验

无，本包只读写组合补丁文件；这些文件点名的行拥有全部面向模型的注册。

#### KV Cache 影响

无；本包既不组装也不发送 provider 请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制界定写入器不会对文件做什么。它们是当前包的约束，不是任务清单。

- **键级而非行级合并**——`setRowField('x', 'config', value)` 替换该补丁的整个 `config` 映射；只想改一个嵌套字段的调用方先用 `rowField` 读出当前值，再把合并后的映射写回。
- **不生成表达式**——写入器只输出普通数据；`!!js` 门是作者敲进文件的东西，从不是某个 API 调用的产物。
- **锁孤儿由操作者处理**——写入器崩溃留下的锁文件不会被竞争者移除，竞争者等待超时后失败；`dsh-atomic-write` 记录了同样的选择。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
