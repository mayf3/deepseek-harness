# Agent Note: Derive the shipped preset root per composition

Status: implemented

[English](2026-08-20-derive-shipped-preset-root-per-composition.md) | 中文

## 问题

`composeProfile` 交付内置 agent-preset 根目录的方式，是在启动时推入一个 overlay：其 `config` 展开已组合的 roster 行后，把 `roots` 硬设为仅含内置根。由于 id 定向补丁会整体替换 `config` 值，这个 overlay 压掉了 profile 的 `cordis.patch.yml`（以及 home 层、`--patch` overlay）配置的全部根目录：把 `agent-presets` 指向共享 preset 目录的部署，启动后只剩内置根加 roster 自己的可写 home 根，所有自定义 preset 从 Web 选择器中消失。`dsh --dump-config` 只组合文件承载的层，所以 dump 显示配置的根目录完好而启动却丢弃了它们——include 自身"dump 永不偏离实际启动"的契约，被一个 dump 看不到的补丁打破。外部报告 discussion #3636 给出了准确的根因。

该 overlay 还位于 `ComposedProfile.overlays`——热重载在新鲜用户层之上重放的固定顶层。overlay 的存在意义是让用户编辑无法顶掉启动器事实，这对 `--patch` 文件和遥测开关是正确的——但 roster 补丁快照了启动时的整个 `config`，导致启动后对该行的任何 `cordis.patch.yml` 编辑（`default`、`includeUserRoot`、`roots`）在重启前都不生效。

## 决定

内置根是一个派生，不是一个 overlay。`resolveShippedPresetPatch(rows)` 从一份已组合的行集构建 roster 补丁：保留全部已配置的键，并把内置根（`system` 信任）前置到组合的 `roots` 中，因此内置 preset 始终挂载并在 id 冲突时胜出，而配置的根目录保持生效。`composeProfilePatches(layers)` 把该补丁追加到展平后的补丁栈，是启动、用户层热重载与配置 dump 共同经过的唯一构建器——热重载从当前用户层派生而非重放启动快照，dump 也渲染这个派生层（标注为 `dsh launcher (shipped agent-preset root)`），使 roster 行的组合与实际启动完全一致。遥测开关仍是仅启动时的 overlay：它是启动进程的环境事实，不携带 config 快照，压过用户编辑正是其目的。

启动器无法静态改写的 `roots` 值——`!!js` 表达式或任何非数组——现在以指明约束的 `TypeError` 大声失败，而不是被静默替换。插件自身的契约不变：`config.roots` 按序扫描，可写 home 根由 `dsh-agent-presets` 自己追加。

## 测试

`shipped-preset-root.spec.ts` 直接覆盖派生逻辑：前置顺序、键保留、无 roster 行时不产出、逐次调用派生、大声失败的拒绝分支，以及经完整 `composeEntries` 应用验证的压掉回归。Web 组合 e2e 现在通过真实的 `composeProfilePatches` 获得内置根，不再手抄启动器补丁（此前三处启动逐字复制了它，其中一处自述"exactly what `composeProfile` supplies"），并新增配置根目录的启动场景：共享根的 preset 与内置四个并列出现、占用内置 id 的目录被其遮蔽、配置根中的 preset 能组合出 agent。built-bin dump 验收断言派生层标签及"内置根在配置根之前"的顺序。无 keyless 快照变更：默认组合产生的补丁栈逐字节相同，且快照框架没有自定义 profile 通道——真实组合 e2e 即是组装应用层面的证据。

## 曾考虑的替代方案

**报告者的修法：在启动时 overlay 内部做前置。** 对压掉问题与优先级顺序判断正确，派生补丁保留了这一形状。按原样采纳被否，因为该 overlay 仍会把启动时的整个 `config` 冻结在所有后续重载之上，该行的实时编辑在重启前依然失效。

**带外提供内置根（启动器提供的上下文值，由插件前置）。** 热重载故事最干净——完全不改写 config——但它把装配事实挪进插件的服务契约，给一个本只读 config 的包加上与启动器耦合的 provide 键，还让有效根目录对配置 dump 不可见。派生补丁把 roster 的输入完整留在组合之内。

## 后果

配置的 preset 根目录在启动后存活，对 roster 行的实时编辑无需重启即生效，dump、活动树与启动对该行的组合完全一致。启动器将 roster 行的 `config`/`roots` 约束为字面量；此前用 `!!js` 生成它们的组合本来就会被静默丢弃表达式，现在必须在某个补丁层实体化该数组。
