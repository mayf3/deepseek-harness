---
description: "面向部署方与维护者的随产品交付 JSONL 会话持久化后端说明，用于选择、配置或排查带可选 Zstandard 压缩的逐会话持久日志。"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-persistence-jsonl

[English](README.md) | 中文

## 概述

`dsh-session-persistence-jsonl` 以规范的具名版本 JSONL generation 存储每个 Session，普通写入向当前文件追加：默认使用带 checksum 的 Zstandard frame，禁用压缩时使用换行分隔的原始文本行。已发布 v0 使用 `session.jsonl[.zstd]`；v1 及后续版本使用小写 `session.vN.jsonl[.zstd]`。迁移会在不改变源文件的情况下于其旁边发布此前不存在的后继文件，绝不重命名、替换或删除已提交 generation 路径。后端提供与任何持久化后端相同的逻辑 `SessionEvent` 流，因此物理命名、压缩、打包、迁移与崩溃恢复仍是存储细节。当消费方需要逐会话磁盘产物时选择它：`locate(meta)` 返回版本限定目标，选择 `compression: 'none'` 后原始 generation 可作为纯文本逐行读取。根目录是唯一必填配置；持久性、延迟物化与中断轮次恢复都随后端提供。

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

当组合需要由按会话文件支撑的持久会话时挂载此后端。常用路径是显式的：加载会话服务、挂载后端，然后给出根目录。

### 何时选择

当消费方受益于每会话一份产物——导航、外部工具或可逐行读取的原始日志——时选择此后端。它是随产品交付的唯一 Session 持久化 provider。后端把会话保存在部署控制的根下：项目本地、共享、临时或集中式。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-session'
- name: '@deepseek-ai/dsh-session-persistence-jsonl'
  config:
    root: /absolute/path/to/session-logs
```

`root` 必填且无默认值：`process.cwd()` 默认值会随进程 cwd 变更而分散会话文件。现有根必须是可读目录；缺失根在第一次实体化时创建。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `root` | 必填 | 所有会话文件的根目录 |
| `packChunks` | `true` | 把符合条件的 `assistant/chunk` 连续段写为打包行；`false` 为诊断保留每事件一行 |
| `compression` | `'zstd'` | 物理编码：`'zstd'` 带校验和帧，或 `'none'` 换行分隔 UTF-8 文本 |
| `preparedSessionCacheSize` | `5` | 为恢复复用而保留的冷会话准备结果数量 |
| `writeBatchMaxDelayMs` | `200` | 实时事件的固定聚合窗口，单位为毫秒 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-session-persistence-jsonl)是每个受支持字段及其 JSDoc 的穷尽式真源。

### 磁盘布局

每个 Session 在可读项目目录下获得一个会话自有目录。每个规范 generation 都以版本与文件名一致的物理 header 开始，之后每个逻辑事件一条存储记录，或每个符合条件的连续段一条打包分片行。格式目录会先翻译所有受支持的历史 header 与事件表示，持久化协调器只接收当前逻辑值。存储记录使用下文所述的无损来源序列表示：

```text
<root>/
  --<normalized-cwd>--/          # readable project directory (or _no-cwd/)
    <encoded-id>/                # session-owned directory
      session.jsonl.zstd         # released v0, compressed root
      session.v1.jsonl.zstd      # released v1, compressed root
      session.jsonl              # released v0, raw root
      session.v1.jsonl           # released v1, raw root; later versions use vN
```

会话 id 在使用前被单射转义为一个安全路径段（无遍历、无冲突）。规范化 cwd 让项目目录保持可读、便于导航；规范化相同的 cwd 字符串共享项目目录，而会话 id 仍选择不同会话目录。`locate(meta)` 不执行任何文件系统 I/O，并为 `meta.version` 返回 `{ kind: 'jsonl', path }`：v0 无版本后缀，每个正版本使用 `.vN`。列表则报告它在磁盘上找到的精确最高 generation。

### 持久性与崩溃语义

Session 延迟物化：`create(meta)` 不写入任何内容，第一次 `append` 会在当前版本的规范文件名下以不覆盖方式写入并 `fsync` 编码后的 header 与第一批。因此，已创建但从未 append 的 Session 不留下任何磁盘内容，除非生命周期消费方调用 `ensureMaterialized`，发布一个无事件 header frame。已 flush 的当前 generation 事件追加为文本行或压缩 frame；捕获到写入或同步失败时，该文件回滚到之前的字节长度，但其路径或 inode 不会被替换。读取受支持历史 generation 的正文时，后端读取一个稳定精确源，解码其可恢复前缀，在内存中组合全部所需迁移边与当前中断轮次修复，只把最终目标写入同目录临时文件并完成校验，重新检查源 fingerprint，再以不覆盖方式发布此前不存在的目标并同步 namespace。POSIX 把临时 inode 链接到目标；Windows 以 write-through 且不替换的方式移动临时文件。如果另一个 writer 已经发布目标，后端只在该目标是普通当前格式文件且字节与预期完全相同时接受它。源路径、字节与 inode 保持不变，中间版本不进入磁盘；构造 Session 前会通过当前 reader 重新打开已提交目标。

### 读取日志

`inspect(id)` 返回带精确继承 cut 的不可变平衡视图；对于已经是当前 generation 的产物，它不提交崩溃恢复。`readFrom(id, fromOffset)` 接受 `SessionLogOffset`，返回该偏移及之后的已存储事件，并在后缀旁保留同一 cut；JSONL 这类顺序介质解析整个选定 generation 并向前跳过。第一次冷正文打开会扫描 Session 目录，选择数值最高的规范文件名；版本高于当前 build 时拒绝，版本较旧且受支持时发布最终当前后继。后端会在单 writer 假设下缓存已校验的当前选择，供同一实例后续打开使用；`list` 与 `listSnapshots` 始终重新扫描并报告目录的最高 generation。`readRaw` 返回该选定 generation，并在 `filename` 中保留其逻辑 basename（v0 为 `session.jsonl`，v1+ 为 `session.vN.jsonl`；由于 `content` 已解码，因此省略 `.zstd`）。保留的低版本 generation 绝不是自动 fallback、restore 或 downgrade 输入。选择 `compression: 'none'` 后，每个 generation 都是外部读取方可直接消费的换行分隔文本；压缩 generation 需要 Zstandard 解码。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节说明物理编码与写入路径；可观察约定已在[使用本包](#use-this-package)中说明。

### 设计理念

该后端是共享 [PersistenceCoordinator](../session-persistence/README.zh.md#understand-the-implementation) 之上的一层薄存储：它加载已存储记录、追加批次、提交修复，并把生命周期编排委托给协调器。其融合正文读取钩子会让同一个稳定物理快照贯穿 generation 分类或迁移与当前格式解码，因此选定文件不会读取两次。校验当前 generation 后，后端会缓存其路径，供同一进程的后续正文打开使用；仅 header 的列表有意绕过该 cache。物理身份仍是文件修订值：device、inode、size 与纳秒时间戳标识一个 generation，并在 append 或 repair 后改变；`listSnapshots` 与保留准备结果的校验会使用它。

### 物理编码

默认产物是独立 [Zstandard 帧](../../../.agents/notes/implemented/architecture/2026-07-19-zstandard-jsonl-session-logs.zh.md) 的标准拼接：一个仅包含 header 行的带校验和帧，后跟每个持久 append 批次一个带校验和帧，使用 Node 内置 Zstandard API 的默认压缩级别（无级别开关）。`sourceEventSeqs` 使用无损存储形式：至少包含三个序列号的连续段会变成 `[start, end]` 区间对，其他列表原样保留；读取时会展开回精确的内存数组。列表只读取并验证 header 帧。`compression: 'none'` 保留相同的存储形式逻辑行，但不使用帧压缩。配置的后缀只选择一次帧格式；代迁移对已解码 JSON 值工作，原始文本文件与压缩文件使用同一套发布算法。一个根只属于一种编码：启动发现与定向查找会拒绝相反后缀，且不提供压缩迁移、混合根回退或双写。启用 `packChunks` 时，符合条件的分片连续段使用格式 codec 的无损打包表示。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config` schema、后端类、协调器接线 |
| [`src/format.ts`](src/format.ts) | 日志路径派生、header 编码、记录扫描、打包行布局 |
| [`src/generation.ts`](src/generation.ts) | 精确源读取、最终目标暂存、源重新检查与后继排他发布 |
| [`src/zstd.ts`](src/zstd.ts) | Zstandard 帧压缩、解码与帧扫描 |
| [`src/win32.ts`](src/win32.ts) | Windows write-through 且不覆盖的文件与目录发布 |
| — | 不发布运行时不变式伴生入口；身份在存储层强制。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从共享持久化模型逐步进入同级后端与物理格式决策。

- [会话持久化子系统](../../../docs/subsystems/persistence.zh.md)——后端无关的服务语义与提供方关系。
- [会话持久化 seam](../session-persistence/README.zh.md)——本后端实现的服务约定。
- [已发布 Session 迁移](../../../.agents/notes/implemented/architecture/2026-08-31-released-session-format-migrations.zh.md)——相邻链、不可变命名与排他发布保证。
- [项目会话目录决策](../../../.agents/notes/implemented/architecture/2026-07-24-project-session-directories.zh.md)——项目与会话目录布局背后的取舍。
- [Zstandard JSONL 会话日志](../../../.agents/notes/implemented/architecture/2026-07-19-zstandard-jsonl-session-logs.zh.md)——带校验和帧编码的理由。

-----

<a id="model-experience"></a>
## 模型体验

### 恢复的对话历史

#### 模型看到什么

JSONL 存储不会向实时请求提供提示词或 schema。加载会恢复已存储的表层历史，并保留之前的请求 header 用于重建；新 loop 组合当前 envelope。恢复会用 `TOOL_NOT_STARTED` 平衡没有持久调用的 assistant 请求；持久调用无结果时则变为 `TOOL_OUTCOME_UNKNOWN`，它要求模型只重试只读或幂等工作，并验证可能的副作用或询问用户。原始 `assistant/chunk` 记录不会重复生成消息。

#### Token 影响

实时请求不新增 token。恢复后的 agent（智能体）会因保留的历史、当前 envelope，以及每个中断调用中以引用形式加入的修复结果文本而消耗 token。

#### KV Cache 影响

JSONL 存储不修改实时请求前缀。只有重建历史、当前 envelope 与模型路由匹配时，恢复 loop 才能重用提供方缓存；崩溃修复结果仅追加。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明本后端何时不合适，或何时需要特别的运维注意。它们是当前包约束，不是任务积压。

- **只加载已配置编码**——受支持的旧 Session 格式会在该编码内迁移；更改压缩仍需要独立或全新根。
- **平铺文件存储布局不加载**——加载前使用独立根，或将预发布产物移入项目/会话目录布局。
- **压缩文件不能直接按行读取**——使用后端加载；或在写入新根前选择 `compression: 'none'`，供外部行读取方使用。
- **不删除 Session generation**——每个规范 generation 都会在 `root` 下累积，直到被外部移除；seam 没有删除 API，也绝不会从数值最高的文件名 fallback 到旧文件。
- **保留不等于 downgrade 支持**——前任文件保留精确证据，并允许 operator 显式复制或检查，但本 build 不自动恢复它们，也不承诺旧 binary 能在后继文件存在后安全重开该目录。
- **每会话一个活动写入方**——append、修复与迁移只在所属后端实例内协调；跨进程写入方隔离需要未来的每会话锁。
- **发布要求不覆盖文件系统原语**——POSIX 的首次物化与后继发布使用 `link()` 加父目录 `fsync`；Windows 使用拒绝既有目标的 write-through move。临时 stage 可以移动或 unlink，但已提交 generation 路径不会。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
