# @deepseek-ai/dsh-client-ui-slash

[English](README.md) | 中文

输入触发流水线插件：光标处的 `/` 与 `@` 检测、分组候选菜单，以及把 pick 路由到已注册 source。斜杠命令检测沿用其词边界与 guard tier 规则；`@` 使用 TUI 的共享语法，只会在输入开头或空白后打开，也能识别尚未闭合的 `@"path with spaces` token。`ctx.slash` 拥有 source roster，并按会话 scope（`sessionOf`）各解析一个 `SlashController`；会话领域的接线层在 controller 上驱动 `track`／`arbitrate`／`onSpace`／`adjudicate`。source 每次调用收到一个 `ClientSessionContext` 投影——会话恒为 agent-backed，因此投影只含会话身份，roster 在 scope 出生时预热一次。流水线对命令零知识：空格／回车裁决按注册序轮询可选的 `matchSpace`／`matchEnter` 钩子，第一个非 undefined 的应答胜出。

分层：`src/core/`（T2）是纯内核——`detectTrigger`、`menuReduce`／`seedGroups`／`MENU_CLOSED`、`exactMatch`，零 React／DOM／cordis；`src/client/service.ts` 是壳层，把内核接到菜单快照 store、逐 hit 候选拉取（以 generation 把关、后继请求经 `AbortSignal` 取代旧请求、失败的 source 静默丢弃并留一条 console 记录）和三条 pick 路径上。`src/types.ts` 与两个 `contract.ts` 文件是冻结的跨包契约（设计 v4 §5.1）；变更需经主线程仲裁。

MenuView 把菜单 store 渲染进 `conversation.input.overlay` slot（列表类，会话 scope），菜单关闭期间渲染 null。候选项的可选 `section` 字段会为每段连续分组渲染一个不可选择的标题，且不会进入键盘选择索引。该 slot 由 ui-conversation 的编辑器配置项拥有（锚点、children 声明、生命周期）；其 SlotMap 类型合并放在本包的 `src/client/slots.ts`，因为依赖方向（ui-conversation → ui-slash）不允许反向的类型导入。combobox 模式：焦点始终留在 textarea，行在 mousedown 时完成 pick，高亮由 `aria-activedescendant` 承载。

pick 结果可以插入普通文本、原子引用 chip，或者请求继续补全。需要继续补全的文本 pick 会替换活跃 token，随后立即根据新草稿重新跟踪；`@file` 目录通过此路径让补全在所选目录下保持打开。

`/client` 导出表层是插件主体（`apply`／`inject`）、`SlashService`、`MenuViewInjected` 与契约类型。MenuView 本身是内部实现——slot 注册以闭包持有它。

## 模型体验

无。触发管线只是浏览器呈现——pick 产出 `CommandClaim`／`ReferenceInsert` 数据，其模型可见后果（host 命令执行；插入的引用文本随普通提示词发送）由消费方的 host 包与输入状态机包拥有。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **只有全局 source 层**：会话 scope 的 source 注册（逐会话遮蔽、类 ScopedLayers 机制）已有设计但未启用；台账记录着触发条件（出现真实的逐会话 source 需求）。
- **`SlashCandidate.icon` 以文本渲染**：MenuView 把该字符串原样放进图标位；接到设计系统图标枚举（iconFile 五变体家族）的接线等该枚举交付后落地。
- **overlay 的 SlotMap 合并归属与 slot 所有权分离**：`conversation.input.overlay` 的合并放在本包（唯一副本），而该 slot 的 owner 语义（锚点、children 声明、生命周期）留在 ui-conversation；依赖方向（ui-conversation → ui-slash）迫使这一拆分，未来依赖关系调整时应重新审视。
- **菜单组顺序即注册顺序**：source 之间没有显式排序 seam；roster 还是 command／skill／reference 时可以接受，更多业务 source 加入后需重新审视。
