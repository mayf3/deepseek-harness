# Agent Note: Remote 事件投递（ctx.remote.$on）

Status: implemented

[English](2026-08-10-remote-event-delivery.md) | 中文

## 问题

[Typert Remote 方法调用](../../implemented/architecture/2026-08-02-typert-remote-method-calls.zh.md)最初只覆盖「一次请求一个结果」的定向调用，明确把 Session 事件流与有状态交互留在别处；Host 向消费端的**单向事件推送**需要一个不归 API Proxy 领域所有的投递机制。

Host 拥有 `agent-preset/selected`、`commands/change`、`credentials/reference-updated`、`llm/adapters-updated`、`settings/document-updated` 等单向事件；它们既不依赖 AgentScope，载荷也本来就是 JSON。若每条事件都要穿过 API Proxy 手写帧、Client Runtime 手写桥和 Client 事件别名才能抵达 UI，这些层不会陈述 owner 事件之外的新事实。

那份重复声明还是**有损**的：client 侧写成 `settings/changed(ns: string)`，brand 类型在这一跳被拍平成裸 `string`，与 Remote 方法侧「消费端类型指向业务包唯一符号」的既有契约相反。

## 决策

消费端 Remote 面持有一个单向事件订阅动词 `ctx.remote.$on(event, listener)`；**名单驱动、原样转发**：

- `packages/api/remotes/src/remote-events.ts` 持有一份可转发 host 事件名单，它同时是「消费端能订阅什么」的唯一控制点。旁边的 `src/types.ts` 由它派生类型投影并填充 selection 座位，按包约定保持纯类型。两个文件**都同时列进本包 host 与 client 两个 face 的 `files`**，两侧读同一份。
- wire 上的事件名 **就是 host cordis 事件原名**（`settings/document-updated`），不加 `host/` 前缀；载荷 **就是 host 的实参列表**，逐元素原样过 JSON，无投影、无脱敏、无改名。
- Host source 由 `api/remotes` 注册到 API Gateway；Gateway 在既有 `/api/remote.mux` 上保留内部 logical endpoint `$events`，不增加物理连接，也不让 API Proxy 解释事件。
- 事件**签名**不另立表：owner 包把自己的 cordis `Events` 声明搬进 client-safe 的 `./types` 纯类型出口，两侧读**同一份**——`$on` 的 listener 类型就是 `Events[Event]` 本身。「原样」不需要证明，是构造性成立的。
- 但**只借 cordis 的类型形状，不接 cordis 的事件系统**：投递语义、注册表、异常处置全归 Typert 自己。

一条 `Events` 条目若签名里够到了 host-only 符号（Service、`Agent`、Context 等），处理方式是**把代码拆到能干净落进 `./types` 为止**；不接受「一半留 index、一半搬走」的分裂声明，也不接受在 `./types` 里造结构等价的影子类型。当前名单内各 owner 都从 client-safe 类型出口提供同一份事件声明。

名单内事件全部走这条路径，专用帧与 Client 别名都已删除。模型消费方直接订阅 `llm/adapters-updated` 和 `settings/document-updated`；preset 消费方订阅 `agent-preset/selected`；Session 与动态 Cordis 的无状态通知使用同一机制。真正需要 baseline、投影或去重的数据仍保留专用 Remote stream。

`skills/change`、`tools/change`、`system-prompt/change` 是同形状的纯失效事件但**没有任何已交付消费者**，按「每个抽象都要有当前 owner 与需求」不进名单，只作为扩展位记录在此。

### 消费端契约（dsh-typert-protocol）

type-meta 加一个**形状谓词**、一个**选择座位**和 `TypertClientRemote` 的**一个**成员；零运行时代码：

```ts
import type { Events } from '@deepseek-ai/cordis'

/** Cordis events shaped for one-way remote delivery: no Scope binding, void return. */
export type TypertForwardableEvent = {
  [Event in keyof Events]: unknown extends ThisParameterType<Events[Event]>
    ? ReturnType<Events[Event]> extends void ? Event : never
    : never
}[keyof Events]

/** The Host assembly's forwarding selection; api/remotes' allowlist fills it, no other package does. */
export interface TypertRemoteEventSelection {}

/** `$on`'s legal keys: selected, and present in the current compilation face. */
export type TypertRemoteEvent = Extract<keyof Events, keyof TypertRemoteEventSelection>
```

```ts ignore-check
/** Subscribe to one forwarded Host event; the returned disposer belongs to the calling fiber. */
$on<Event extends TypertRemoteEvent>(event: Event, listener: Events[Event]): () => void
```

`Events` 按程序解析：host 程序里是 host 事件全集，client 程序里是 client 编译面看得见的那些——同一个谓词在两侧各自成立，不需要把 host 声明拖进 client。

**契约只公开消费动词。**`ClientRemoteService` 激活时就把内部唯一的 `$events` pump 注册为 Connection generation source，与当前有无 `$on` 订阅无关；浏览器通过共享 Remote mux 打开 `$events`，进程内组合通过 `connection.rpc.open` 打开同一 logical stream。解码、精确 item 校验和订阅表派发都是 Gateway Client 的私有实现，`TypertClientRemote` 不暴露生产方方法，因此业务插件不能伪造一条 Host 事件。

每次 Host 打开 `$events` 时，API Remotes source factory 先同步挂载所有 allowlist listener，Gateway 随后产出首项 `{ type: 'ready' }`，再开始迭代事件 source。`ConnectionController` 并行等待该 ready 与 `host.describe`，只有两者都成功才发布 `connected` 并允许 baseline 读取。这个顺序保证 baseline 不会跑在增量 listener 前面。

物理 mux 断开会让 logical stream 以 `RemoteStreamCarrierError` 结束；Host 返回的 Remote stream error、意外正常结束、非 ready 首项或畸形事件项也会结束当前 generation。Connection 撤回该 generation 的 `hostDescription`，在退避后重开 `$events` 和 `host.describe`；Gateway mux 只负责重建物理 WebSocket。转发事件不重放；凡正确性依赖恢复的状态，owner 必须另有查询、cursor 或 opening baseline，不能把 `$on` 当作可靠日志。

投递语义与 cordis 事件系统不共用实现：只有单向投递，没有 waterfall / bail / parallel / serial 模式，也没有 `@mode` 概念（`ReturnType extends void` 是这条纪律的静态表达）；不绑 `this`；没有 `EventOptions`、`prepend`、优先级；按注册顺序逐个调用，单个 listener 抛错或返回拒绝的 Promise 都就地隔离并记日志，不能拖垮事件投递或 Connection generation。

### 名单：两个 face 共读的同一份声明

`packages/api/remotes/src/remote-events.ts` 同时列进 `tsconfig.host.json` 与 `tsconfig.client.json` 的 `files`，是名单的**唯一家**；`src/types.ts` 由它派生类型面：

```ts
// remote-events.ts — the value
export const API_REMOTE_FORWARDED_EVENTS = [
  'agent-preset/selected',
  'api-session/activity',
  'api-session/added',
  'api-session/error',
  'api-session/removed',
  'api-session/status',
  'commands/change',
  'credentials/reference-updated',
  'cordis/request-run',
  'cordis/request-run-resolved',
  'cordis/dynamic-package',
  'cordis/dynamic-retract',
  'cordis/inspect-query',
  'cordis/inspect-query-resolved',
  'llm/adapters-updated',
  'settings/document-updated',
] as const

// types.ts — the type face, derived
export type ApiRemoteForwardedEvent = typeof API_REMOTE_FORWARDED_EVENTS[number]

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteEventSelection extends Record<ApiRemoteForwardedEvent, true> {}
}
```

于是**加一个事件只改这一行数组**：类型投影、`$on` 的键面、host 的转发循环全部从它派生。`ctx.remote.$on('slots/changed', …)`（client 本地事件）或 `$on('skills/change', …)`（名单没开）都是**编译错误**。

host 半再加一处形状断言，把 host 事件词汇的约束落到同一份名单上：

```ts ignore-check
API_REMOTE_FORWARDED_EVENTS satisfies readonly TypertForwardableEvent[]
```

写成表达式语句而不是命名常量：后者会被 `noUnusedLocals` 判为未使用（下划线前缀只豁免参数）。它卡住三件事：**名字合法**（谓词以 `keyof Events` 为基）、**不绑 Scope**（`goal/changed` 那族的 `ThisParameterType` 不是 `unknown`，被排除——「不依赖 AgentScope」的静态表达）、**单向**（非 `void` 返回的 waterfall/bail 形状被排除）。

**「原样」不在任何地方证明，而是构造性成立**：`$on` 的 listener 类型取自 owner 包 `./types` 里那一份 cordis `Events` 声明，host 转发读的是同一份，不存在可以彼此偏离的第二份声明。

载荷 JSON-safe 交给运行时：`api/remotes` 的 Host source 在入队前用 `dsh-session` 的 `isJsonValue` 逐元素校验，不合格**抛错 fail loud**（这是名单配置错误，不是外部输入）。

### 线协议（API Gateway Remote mux）

```ts ignore-check
{ type: 'ready' }
{ event: string; args: JsonValue[] }
```

Client 以 endpoint `$events` 和 payload `{ args: {} }` 打开 internal logical stream。Gateway 拒绝额外参数、缺失 Host source 和重复 source 注册；source 被撤回时会中止所有由该注册打开的 stream。每个 Client stream 在 `api/remotes` 中拥有独立队列与一组 allowlist listener，因此一个 Client 断开不会消费或撤销另一个 Client 的事件。

Client 要求首项恰好是只含 `type: 'ready'` 的对象，后续每个 item 则恰好包含非空 `event` 与数组 `args` 两个字段。浏览器 wire 的 JSON 解码保证元素是 JSON 值；进程内载体则读取同一个已经过 `isJsonValue` 校验的 Host source。未知但结构合法的事件名会在没有订阅者时静默丢弃。

`$events` 是 Gateway 内部 endpoint，不进入生成的 Typert Remote descriptor，也不成为 `ctx.remote.<namespace>`。应用选择仍只存在于 `api/remotes` 的 allowlist 和 Host source；Gateway 只拥有注册、payload 校验与物理传输。

### apps/web 的 browser e2e 属于 Host 面

`apps/web/tests/**` 那批 e2e 在**根 `tsconfig.host.json`** 做类型检查：它们在进程内起真 harness、直接摸 `ctx.apiProxy`、host `SessionStore.get/create/flush`、`ctx.sessionProjectionCache`。**运行时用浏览器 ≠ 类型上属于 client 程序**——把它们搬进 client 聚合会立刻报 21 条错，因为一个 program 装不下两个 face 对同一个 Context key 的合并。

由此得到一条对本设计要紧的连带纪律：**这些测试从客户端包 import 值或类型，会把该包的整个 project——以及它引用的每个 project——拖进 Host 构建图**。`ui-settings-general`/`ui-settings-models`/`ui-permission`/`ui-commands` 四个消费者 references `api/remotes` 的 client face，而该 face 必须等 host tsdown 生成 `@deepseek-ai/dsh-goal/remote` 才能编译，于是形成构建期死锁：host tsc → api/remotes client face → `goal/remote` → host tsdown → 排在 host tsc 之后。

所需的客户端符号在测试侧**镜像**了一份（`scaffold.ts` 导出镜像后的 welcome-notice 常量，两个 chat e2e 直接引 `dsh-client-runtime/client` 因为 `runtime` 工程本来就在 host 图里），从而让那 4 个消费者离开了 host 图；`apps/cli/tsconfig.json` 里 15 条 client 工程引用随之失去 owner-map 职责，已一并删除。镜像值与源逐字一致，漂移的表现是选择器失配或通知未被抑制，都是响亮失败。

### 改动清单

| 位置 | 改动 |
|---|---|
| `dsh-typert-protocol` | `src/types.ts` 提供 `TypertForwardableEvent`、`TypertRemoteEventSelection` 与 `TypertRemoteEvent`；`TypertClientRemote` 只公开 `$on`。纯类型，零运行时 |
| `api/gateway` | Host 半提供唯一 Remote event source 注册位、`$events` logical stream 与 opening ready 项；Client 半把私有 pump 注册为 Connection generation source，负责 item 校验、按注册顺序派发以及 listener 异常收容 |
| `api/remotes` | `src/remote-events.ts`（名单值）与 `src/types.ts`（类型投影 + 选择座位）双列进两个 face；Host 半注册每 Client 独立的 allowlist source，并在入队前校验 JSON；Client 半继续组合生成的 Remote contribution |
| 根 `tsconfig.base.json` | 加 `dsh-settings/types`、`dsh-credentials/types`、`dsh-api-remotes/types` 三条 `paths`，全部指向**源**平面 |
| `dsh-commands` / `dsh-settings` / `dsh-credentials` | `interface Events` 子块移入各自 client-safe 的 `./types`（settings/credentials 新建该出口，brand 与纯类型一并移入，index 继续 re-export 并留住构造器；`files` 补 `lib/types/**/*.js`） |
| `host/apiproxy` | 不包含 `HostFrame`、`events.host()` 或其他 Host 下行 carrier；API Proxy 不参与 Host 事件或 Connection generation |
| `dsh-session` | `isJsonValue` 供 `api/remotes` Host source 校验每个事件参数 |
| `client/runtime` | 删除 Host frame 到 Remote subscription table 的桥；只继续在 Connection generation 建立后发布 `connection/reset` |
| 消费方 | Client 插件直接订阅 `ctx.remote.$on(...)`，type-only 引入 owner 事件声明并把 `'remote'` 加进 `inject` |
| `client/connection` | 提供唯一 generation source 注册位；`ConnectionController` 以 `$events` ready 与 `host.describe` 组成世代握手，fixture 也从同一 source 产生事件 |
| `apps/web/tests` + `apps/cli` | 客户端符号镜像（见上节）；`apps/cli/tsconfig.json` 删 15 条 client 工程引用 |

## 备选方案

**继续寄生 API Proxy 的 Host downlink。**这样可以复用 Connection generation 和 `connection/reset`，但会让 API Proxy 保留 Remote 事件 allowlist、队列、schema 和 Client Runtime bridge，领域传输也无法随其他 Remote stream 共用生命周期。API Gateway 已有常驻 `/api/remote.mux` 后，`$events` 只增加一个 internal logical stream，不需要第三条 WebSocket，因此转移到 Gateway 的成本和所有权都更合理。

**给 Remote 事件另开第三条物理 WebSocket。**独立通道能拥有自己的连接状态，但会重复 Gateway mux 已经提供的认证升级、复用、取消、错误映射和退避重连。内部 `$events` endpoint 保留独立 logical stream，同时复用一条物理连接。

**在 type-meta 立一张独立的 `TypertRemoteEventMap`，让 owner 包 declare-merge 进去**。消费端键集会精确等于「被声明为可远程投递的事件」；代价是每条事件的签名要在 cordis `Events` 之外**再写一遍**，于是需要一条双向 `extends` 的等价性证明来防漂移，还要给三个 owner 包新增 type-meta 依赖。共用同一份 `Events` 声明让等价性变成构造性成立，这张表因此不立。

**让 typert generator 从 host `Events` 声明生成事件投影**（codec + `.d.ts` + 声明映射，与 `/remote` 同族）。generator 已经在分析 host 事件；但它拿不到投影与脱敏语义，且要动生成器与构建面。原样转发这条路本就不需要投影。

**给可转发事件加载荷投影函数**（`{ 事件名, 投影, zod }` 转发表）。能一举覆盖 `models-changed` 的 fan-in 与 workspace 的 view 派生；代价是投影逻辑与载荷类型手工对齐，回到方法侧刚刚消灭的中心表形态。

**把 apps/web 的 browser e2e 搬进 client 聚合**。看似「客户端测试归客户端面」，实测立刻 21 条错：它们用 host 服务，而 client 程序里 `ctx.sessions` 是 `ISessions`。已否。

**给 `directory-picker-browse`/`-native` 做 host/client 双 face 切分**，从根上让客户端包不进 host 图。方向正确（它们确实是未切分的双半包），但改动落在别人属地，而收益只是「构建图更干净」——本设计在测试侧镜像客户端符号之后已经不需要它。**已评估不做**。

## 验证

钉住该行为的东西：

- Host source 真组合测试：两个 Client stream 各自收到 host emit 的 `{ event, args }`，其中一个断开不会影响另一个；非 JSON 实参会响亮拒绝且不会毒化后续合法事件。
- 类型层负例拒绝三类候选：不是事件的名字、绑 Scope 的事件（`goal/changed`）、返回值非 `void` 的事件。`$on('slots/changed', …)`（client 本地事件）与 `$on('skills/change', …)`（已声明但未选中）都编译失败——因此 `$on` 的键面恰好等于名单。
- 消费端 `$on('settings/document-updated', …)` 把 `ns` 解析为 `SettingsNamespace`：brand 穿过 wire 存活。
- `$on` 的 disposer 归属调用方 fiber；同一个函数对象订阅两次时两条注册各自独立退订——按 listener 身份做键的表会把它们合并，所以订阅按注册项寻址。
- 投递同时收容抛出的 listener 与拒绝所返回 promise 的 listener：声明返回值是 `void`，没人 await 异步 listener，其拒绝否则会完全逃出这层收容。投递遍历快照，因此派发中订阅或退订都不会改变本帧的接收者集合。
- Gateway 测试覆盖 source 缺失、重复注册、撤销中止、payload 拒绝、ready 先于事件，以及浏览器与进程内两种 carrier；Client 测试覆盖 generation source 注册边界、描述与增量就绪顺序、物理失败后重开、Host 错误与意外结束、非 ready 首项、畸形事件项和 dispose quiescence。
- JSON 参数校验直接在 Host source 上覆盖：类型化的 `ctx.emit` 通常造不出畸形值，但 runtime allowlist 配置错误仍必须响亮失败。
- `host/remote-event`、公开 `$dispatch`、Client Runtime bridge 和 API Proxy 的 allowlist 依赖都不存在；各消费方直接观察 owner 事件。

## 后果

- **Gateway 有一个非生成 endpoint**：`$events` 不对应业务 namespace，也不进入 Typert descriptor；它是 Gateway 与 `api/remotes` 之间的内部连接点，同时定义 Client Connection generation 的存活期。严格的空 payload 校验、opening ready 校验和单 source 注册限制它不会演化成第二个手写业务 API。
- **两个文件打破了 api/remotes 的 face 互斥约定**：`src/remote-events.ts` 与 `src/types.ts` 同属两个工程，各自向共享的 `lib/types` 发射一份相同声明。内容逐字节相同、`.tsbuildinfo` 各自独立，实践上无害；README 的构建边界节陈述了这个例外及其成因（`paths` 指向源码面）。
- **生产方保持私有**：业务插件只能调用 `$on`；Host source 注册和 Client 派发都不在 `TypertClientRemote` 上暴露，测试 double 以自己的 `emit` 方法驱动订阅，不伪装成生产接口。
- **畸形实参在 emit 点失败**：`api/remotes` listener 在入队前抛出，因此调用 Host `ctx.emit` 的操作立即看到名单配置错误；队列仍可继续投递后续合法事件。
- **测试侧镜像值可能漂移**：没有任何机制核对 `apps/web/tests` 中镜像的 client 常量与其源；安全网只是漂移会让选择器失配。规则写在 `apps/web/tests/README.md`，由 review 守；grep 级门禁经评估后刻意不做。
- **放弃的能力**：不支持投影或脱敏载荷、不支持 Scope 化事件（`agentCtx.remote.$on`）、重连不重放。需要可靠恢复的状态必须拥有查询、cursor 或 opening baseline；可应答交互与快照状态不应进入 `$on`。
- **仍有 client 包留在 host 图里**：12 个工程（`connection`、`runtime`、`ui-slots` 等）经未拆分的 `directory-picker-browse`/`-native` 与 `api/gateway → client/connection` 仍可达 host 图。它们都能编译且不再牵连 api/remotes 的 client face，因此没有阻塞本次改动；拆分那些包能减少几个，但经评估后不做。两个 chat e2e 直接引 `dsh-client-runtime/client` 依赖 `runtime` 本来就在图里——属偶然而非保证。
- **invariant companion 不做运行期检查**：早先的修订曾在活事件总线上断言投递形状（`thisArg === null`、`mode === 'emit'`），这让 companion 与名单值耦合，并使 rolldown 把它提成第三个 bundle chunk——而机械推导的发布文件清单并不携带它。host 面的 `TypertForwardableEvent` 断言在编译期已拒绝这两种偏离，因此该 companion 是一个带说明的空 installer。
