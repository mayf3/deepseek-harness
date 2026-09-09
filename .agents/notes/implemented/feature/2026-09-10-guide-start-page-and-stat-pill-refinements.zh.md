# Agent Note: 引导起始页与统计 pill 的细化

Status: implemented

[English](2026-09-10-guide-start-page-and-stat-pill-refinements.md) | 中文

## Problem

右侧边栏的引导 tab 只是一列光秃秃的入口胶囊：上方没有视觉锚点，胶囊只能显示标题，而类型没注册图标的入口干脆不画图标，混合列表看起来像坏了而不是稀疏。另外两个聊天统计面有噪音：输入框下方的会话 token 用量弹窗给从未写入缓存的会话打印一行 `Cache write 0 tok`；turn 级用时 pill 总是可以点开弹窗，即使弹窗只有一行、且内容重复 pill 自己的标签——同一格式化函数、同一数值——点击毫无所得。

## Decision

**引导页是罗盘压着能自我说明的胶囊。** [GuideBody.tsx](../../../../packages/client/ui-sidebar-right/src/client/tabs/guide/GuideBody.tsx) 在入口胶囊上方画一枚弱化的 56px 罗盘，不加标题，如同浏览器起始页不给它的入口配说明文字。[`SidebarRightGuideEntry`](../../../../packages/client/ui-sidebar-right/src/client/tab-registry.ts) 新增可选的 thunk 化 `description`——与 `title` 一样每次渲染重新读取，语言切换无需重新注册。仅当引导页列出的入口不超过 `MAX_DESCRIBED_ENTRIES`（4）个时，胶囊才在标题下显示描述；更长的列表去掉所有描述以保持轻盈，所以类型必须靠标题立得住。图标随胶囊高度变化：单行标题旁 22px，两行旁 26px。

**没有图标的入口回退到内置的立方体占位符。** 回退在渲染点决定（`entry.icon ?? CubeGlyph`）而不在注册时，因此每个贡献者——内置或扩展——得到统一的占位符，链式替换 body 时规则随之整体替换。`CubeGlyph` 与 `CompassGlyph` 一起放在 [GuideTitle.tsx](../../../../packages/client/ui-sidebar-right/src/client/tabs/guide/GuideTitle.tsx)：一只等距视角的盒子，1.1px 直线描边、圆角拼接、走 `currentColor`，用 `--dsw-alias-label-tertiary` 着色——比注册图标的墨色浅一档——标记这个槽位无人认领。files 类型在 [definition.tsx](../../../../packages/client/ui-sidebar-files/src/client/definition.tsx) 注册了描述和共享的文件夹图标。

**会话用量弹窗去掉为零的缓存写入行。** [StatsPills.tsx](../../../../packages/client/ui-chat/src/client/chat/StatsPills.tsx) 仅当 `cacheWriteTokens !== 0` 时渲染 `Cache write` 行，与 per-turn 面板去掉缺失可选字段的做法一致；始终存在的桶（输入、缓存读取、输出）保留各自的行。

**turn 用时 pill 在弹窗只会重复自己时变为静态。** [TurnUsagePanel.tsx](../../../../packages/client/ui-chat/src/client/chat/TurnUsagePanel.tsx) 的 `TurnTimePanel` 恰好在 `tokensPerSecond` 与 `ttftMs` 都缺失时渲染纯文本——无 hover、无弹窗——因为弹窗唯一无条件的行就是 pill 已经用同一格式化函数展示的时长。两者任一有记录时 pill 仍是按钮。静态形态复用 `.trigger` 类保持几何尺寸，再用 `.static` 类压掉 hover 和指针，窄视口的图标折叠行为保持不变。

## Alternatives considered

**把立方体注册进 `ui-primitives`。** 其 `icons/index.tsx` 是导入的 figma `ic_ds_*` 集合，而立方体只有一个消费者；`CompassGlyph` 已开了引导图标包内自持的先例。

**在注册时默认图标。** 注册表内部的 `?? default` 会对 body 隐藏回退，让"没注册图标"无法辨认，浅色占位墨色随之丢失；显式的渲染点回退让注册保持诚实。

**显示 `Cache write 0`。** 用不写缓存的 provider 的会话会永远挂着这一行；这里的零意味着"没有这回事"，不是一次测量。

**保留单行的用时弹窗。** 全部内容都在重复触发器标签的弹窗会教用户认为这个交互是空的；隐藏交互本身才是诚实的信号。

## Consequences

`description` 是新的 pre-stable 注册表 API；所有消费者已同步更新（files 入口注册了一个）。4 个入口的阈值是引导 body 的内置常量，不是配置。guide-body 用例覆盖占位符（尺寸与墨色）、描述阈值两侧和已注册图标路径；chat-stats 用例覆盖缓存写入行的去除与保留；turn-usage-panel 用例覆盖静态 pill 和两种单数据弹窗。`ui-sidebar-right` 与 `ui-sidebar-files` 的 README 重述了引导页规则。
