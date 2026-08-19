# Agent Note: Session log 版本机制：单调整数、升级器链、逐事件可忽略标记

Status: implemented

[English](2026-08-10-session-log-version-mechanism.md) | 中文

## 问题

Session log 在发布后必须能升级格式，而最先发布的运行时决定了此后一切的下限：第一个发布版的读取器缺少哪种拒绝和降级行为，用户手里已经装上的副本就永远补不上。发布 issue #1901 的最低要求是老运行时读到新 Session 格式时明确报不支持，而不是读错。改动前的读取器在两个方向上都做反了：`assertVersion` 对任何版本不匹配抛出同一条不区分方向的消息；JSONL 解码器把不认识的事件类型原样放行，重建时静默跳过，恢复出一个内容残缺的会话且没有任何诊断。

## 决定

**一个单调递增的整数，不分大小版本。**某一步能不能自动升级是那一步自己的属性，由它的升级器存在与否表达，不该由两级编号方案提前承诺（设计时很少能预知下一个变更算不算"大"）。这与 SQLite 后端 `SCHEMA_VERSION` 的先例一致。

**升不升版本由写入方决定，与读取方能力无关。**当且仅当老运行时无法在语义上完全正确地处理新日志时才必须升版本。"解析不报错"不是标准：静默跳过影响重建的内容就是读错。只有结构性变更够得上这条线：header 形状、事件信封、核心事件语义、surface 机制（`SurfaceEventType` 集合、`SurfaceOp` 变体）。拿不准就升：近似恒等的升级器几乎没有成本，漏升一次会让老读取器静默读坏。

**读取规则按方向区分。**版本相等：正常解码。比读取器新：拒绝，说明方向（"由更新的 harness 写入，请升级"），并给出原始日志文件的路径，用户仍能看到文本（`SessionFormatUnsupportedError`，与 `SessionPersistenceCorruptionError` 区分，因为数据没有损坏）。比读取器旧：要求静态 n→n+1 `SessionFormatStep` 组成完整链路，缺失任何一步都会拒绝并指出断点。注册表属于 build 而不是 Cordis composition，因此同一个 build 在任何插件组合下都具有相同的持久化读取能力。

**格式迁移就是 decoder，不是 Coordinator 的修复分支。**后端通过可重复读取的 `StoredSessionSource` 把解析后的持久化数据作为 `unknown` 暴露：一个原始 header、一个精确 revision，以及每次产生独立 `AsyncIterable` 且绑定该 revision 的 `readEvents()` factory。每一步实现 `migrateHeader()` 和惰性的 `migrateEvents()` 转换，只能前进一个版本，也不能改变 Session id 或 cwd。只要发生版本转换，就读取完整事件流，并在所有步骤完成后才应用请求的 suffix；版本相等时仍保留 backend suffix seek。Decoder 验证每一步输出的 header version，完整链路结束后才执行当前 `SessionHeader` 和 `SessionEvent` 校验。

**以后每次 format bump 只增加一个格式步骤。**改动新增 `format-migrations/vN-to-vN+1.ts`，把该步骤导出到静态 `SESSION_FORMAT_STEPS` 数组，并递增 `SESSION_FORMAT_VERSION`。这一步自己负责它接受的所有旧 header 和 event 变体、iterator 转换中的跨事件状态，以及对畸形输入的明确失败。Backend 和 Coordinator 不增加版本特判。没有改变版本号的历史变体继续隔离在 format-v0 compatibility decoder 中，不作为后续版本步骤的模板。该 decoder 将历史 `compact/start`、`compact/summary`、`compact/end`、`compact/prune` 名称映射为规范的 `compaction/*` 事件，并保留每条记录的其余内容。

**Recovery 和写回只消费当前格式数据。**`inspect()` 和 `readFrom()` 只在内存中解码。Cold `prepare()`/`load()` 先解码完整 source，补充当前 recovery closers，再用完整、平衡的当前格式 stream 替换精确的旧 revision。Live HMR adoption 在 seed 校验后使用同一个 replacement primitive，但不会为仍由 live Session 掌握的 turn 合成 closer。替换成功或 revision 冲突后都会丢弃 prepared object，重新打开持久化 source 后再继续。

**Replacement 是 backend 内部的 compare-and-swap。**`replaceStored(expectedRevision, meta, events)` 接受流式当前格式日志，并在提交排他区内检查存储身份和 source revision。JSONL 写入并 fsync 同目录临时 artifact，在持有跨进程锁时复核 revision，原子替换路径（Windows 使用 write-through replacement primitive），并在 POSIX 上同步父目录。SQLite 先暂存 event iterator，再在一个事务中复核并替换 header 与 event rows。提交失败后只会留下完整旧日志或完整新日志；永久保留升级前副本是独立的恢复策略，不属于 format migration API。

**逐事件的 `ignorable` 标记吸收词汇表增长，普通的新增事件永远不用升版本。**事件词汇表由挂载了哪些插件决定，单个版本整数描述不了它。读取器遇到不认识的事件类型时拒绝解读日志，除非该事件的信封带 `ignorable: true`。默认为必需：忘写标记的后果是把一个本可恢复的会话拒绝过头（体验问题），而默认可忽略会让同样的疏忽静默恢复出残缺会话（安全事故）。架构保证了这条规则成立：模型可见内容只经三种带 `surfaceOp` 标记的 surface 事件加 `request/header`、`request/context` 折叠进入重建，危险的未知事件恰好是那些不进 surface 但改变日志其余部分解读方式的事件（`session/end-seed` 是现存例子）。

## 影响

Format v0 包含：分方向的拒绝并带原始日志路径；基于生成的已知词汇清单（`KNOWN_SESSION_EVENT_TYPES`，由 `gen-persistence-catalog` 从所有 `SessionEventMap` 声明合并生成，`verify-persistence-catalog` 保证新鲜）的未知事件守卫；`ignorable` 信封字段被种子校验、两个后端（SQLite 专用列，`SCHEMA_VERSION` 15）和 BFF 线上 schema 接受；以及使用空相邻版本注册表的静态流式 migration decoder。`SESSION_FORMAT_VERSION` 保持 0，直到真实 v0→v1 步骤合入。Decoder 和 backend replacement API 因此可以直接测试，不需要制造一次 format bump。写入侧目前不写 `ignorable`，因为还没有生产者需要它。在注册表面出现之前，仓库外插件的事件在第一方读取器下无法恢复会话；拒绝是显式的而非静默的。未知类型守卫只在读取侧生效：`appendCore` 继续拒绝已淘汰的 legacy 形状，但不对新类型做词汇检查，因为写入时拒绝会让活跃会话的持久化中途停摆，代价大于下次加载时的显式拒绝。JSONL 后端还会在校验当前 header 字段、解码任何 event record 之前，直接从原始 header 行拒绝外来版本，因此结构完全不同的未来格式仍会报告升级方向而不是"损坏"；SQLite 则先由自己的 `SCHEMA_VERSION` pragma 把关整个文件的结构。

## 曾考虑的替代方案

- **大小两级版本号**：能否转换这一位信息属于每一步的升级器，把它预先固化进编号形状会做出错误承诺。
- **未知事件默认可忽略**：把忘写标记的后果从可见的过度拒绝反转成静默损坏。
- **查看时自动迁移落盘**：打开即改写把读操作变成破坏性写操作，转换器的 bug 会在浏览时损坏日志，同目录的旧版本运行时也会因为新版本只是看了一眼就失去访问能力。
- **插件运行时注册已知事件类型**：会让已知集依赖插件组合，同版本的精简组合会拒绝完整组合写出的日志。生成的全仓库清单保证同版本读取行为一致；仓库外插件的事件按构造就在清单之外，为它们提供注册表面推迟到真有这样的消费者时再做。
- **把 migration 物化为 header 和 event 数组**：即使每步转换只依赖单条 record，也会让框架内存占用与完整日志大小成正比。可重复、绑定 revision 的 reader 加 iterator 转换保留重试语义，又不强制这笔分配。
- **在 `PersistenceCoordinator` 内写版本转换**：会把格式解码和各操作不同的 crash recovery 混在一起，并在 inspect、suffix read、cold continuation 和 live adoption 间复制行为。共享 decoder 只产出当前格式数据，各 consumer 保留自己的 recovery intent。
- **每次升级都强制永久备份**：原子性不依赖永久副本，而且 JSONL 与 SQLite 无法承诺相同的物理表示。Backend 可以把恢复副本作为独立产品策略加入，不需要修改 migration。
