# Agent Note: steer 与 follow-up 的图片投递

Status: implemented

[English](2026-08-27-steer-followup-image-delivery.md) | 中文

## Problem

agent 运行期间提交的图片没有可靠进入模型上下文，也没有保持预期的浏览器显示位置（#3186），原因有四个，彼此独立。

第一，splice 进在线 driver 的 steer 或 follow-up 不会锁存唤醒：预期由在线 driver 自行认领，但轮次在 splice 与认领之间正常结束或失败时，退出路径不再复查，已接受的消息就滞留到下一次无关的唤醒发送。图片准入放大了这个窗口，因为 Host 在执行 `agent.steer()`/`agent.followup()` 之前要先等待附件规范化完成。

第二，可继续子代理的 follow-up 在客户端就拒绝图片（`SUBAGENT_IMAGE_UNSUPPORTED`），并把图片部分从纯文本调用中剥掉。Host 路由完全没有准入，wire 内容又是 `ContentBlock[]`，单独放开客户端拒绝会允许浏览器引用任何它从未上传过的 `attachmentId`。

第三，浏览器队列投影把已排队的图片折叠成文本 `[image]`，尽管持久化引用已经存在，并且可以通过会话附件授权读取。

第四，浏览器序列化图片字节期间，所有本地提交回显都位于 Chat 消息流末尾。直接 steer 会在准入前等待阶段显示为普通聊天消息，Host queue snapshot 到达后才移到 pending-steering 位置。繁忙时 Queue 发送也会发生同类跳动，最终进入 QueueDock。

## Decision

**轮次收尾期的唤醒投递。** `ReactLoopAgent` 用 `pendingWakes` 记录尚未被认领的唤醒发送的身份；认领与丢弃通知会移除对应条目。当 driver 的轮次循环无异常返回并退出时，集合非空就重新拉起 driver，输掉与正常收尾轮次竞态的 steer 或 follow-up 由新轮次认领。取消与 `agent/pre-step` 拒绝则清空该集合：已接受但未认领的输入停放到下一次唤醒发送，既保留了有测试保护的 `cancel({ keepInbox: true })` 语义，也避免把被拒绝的认领重新塞给同一个拒绝策略。注入的上下文从不进入该集合。投递与停放规则记录在 [docs/architecture.md](../../../../docs/architecture.zh.md) 的 turn-flow 一节。

**Host 侧子代理图片准入。** `SubagentPromptRequest.content` 改为上传形态的 `PromptContentPart[]`（同步更新 [Web 子代理会话](../feature/2026-07-27-web-subagent-conversations.zh.md) 的 wire 契约）。`dsh-attachment` 负责子代理路由使用的共享上传词汇；`dsh-api-session-controller` 保留结构相同的 Client face 声明，使生成的 Client Cordis 目录包含完整的 prompt part 字段，并用编译期等价测试防止两处定义偏离。共享的 `durablePromptContent()` 转换位于 `dsh-llm/content`，Session prompt 端点与 `SubagentRuntime.prompt` 共用。子代理路由在 `followup()` 之前经 `ctx.attachments` 完成整批图片的准入与持久化；continuation 管理器在逐子级锁内，当子级 `agent.options` 路由解析到不接受图片输入的模型时拒绝投递（`MODEL_DOES_NOT_SUPPORT_IMAGES`，以与 Session 路由一致的 `attachment-error` 词汇表上抛）。子级没有固定 options 路由，或部署未挂载 LLM 注册表时照常投递，交给 LLM 层的纯文本投影。客户端原样转发图片部分，`SUBAGENT_IMAGE_UNSUPPORTED` 文案删除。

**队列展示。** 队列镜像的文本预览不再包含图片块，queue dock 把每个持久化图片部分渲染为缩略图，经 `ctx.uiConversation.imageUrl` 解析，与会话记录使用同一个会话授权读取。已排队图片消息的编辑仍然拒绝（#3072）。

**稳定的乐观显示位置。** `PendingSubmission` 记录提交开始时选定的区域：空闲发送是 `transcript`，繁忙时 Queue 发送是 `queued`，繁忙时 Steer 发送是 `steering`。Chat 分别在 transcript 与 steering 区域渲染对应回显，QueueDock 用浏览器持有的图片预览渲染 queued 回显。现有 `rpcId` 关联会在 Host queue occurrence 或持久化 user node 出现的同一次渲染中隐藏本地回显。如果图片序列化期间轮次关闭，Host 把请求的 steer 放入 next-turn queue，消息随后从 steering 移到 QueueDock，反映实际投递决定。

## Alternatives considered

**任何 driver 退出都在有滞留输入时重新拉起。** 拒绝：这破坏 `cancel({ keepInbox: true })` 与 pre-step 拒绝的刻意停放语义，而且 `turn/start` 提交前失败的轮次永远不会认领消息，会进入热循环。

**对发给在线 driver 的发送也锁存 `wakeRequested`。** 拒绝：锁存不随认领清除，被认领的 steer 加上剩余的注入上下文会在退出时开出一个只有上下文的轮次，违反注入上下文必须等待唤醒消息的规则。

**wire 内容保持 `ContentBlock[]`，由 Host 准入引用。** 拒绝：引用形态的 wire 允许客户端伪造 `attachmentId`；上传形态的 wire 使 Host 准入成为子级消息里附件引用的唯一来源。

**在 `SubagentRuntime.prompt` 里做子级图片能力检查。** 拒绝：该路由可能寻址冷的子级，其 agent 尚不存在；continuation 管理器在两条分支里都拿得到在线或刚物化的 agent，并且处于逐子级投递锁内，检查不会与并发投递竞态。

## Testing

agent-loop 测试确定性地钉住收尾窗口（`turn/end` 监听器把发送排为微任务，先于 driver 的退出续体执行），覆盖 steer、follow-up 与注入不投递。Host 测试覆盖 `mode: 'steer'` 的图片准入；subagent control 测试覆盖有序准入、整批拒绝、非规范 base64 与能力拒绝映射；continuation 测试覆盖拒绝时不留半条消息、能力通过时投递、无路由时的顺延。客户端测试覆盖不剥离的转发、目录可见的上传声明、队列缩略图（加载、失败占位、卸载）、不含图片的预览、序列化前的位置捕获、steering 本地显示、queued 回显显示，以及两个区域的 `rpcId` 交接。

## Consequences

在轮次最后几个微任务里被接受的 steer 或 follow-up 由新轮次投递，不会挂在 inbox 里；用户取消仍然停放待处理工作，停止之后的投递依旧需要一次显式的唤醒发送。图片序列化较慢时，乐观消息停留在选定的 transcript、QueueDock 或 pending-steering 区域，直到与 Host 状态交接。subagent 包依赖 `dsh-attachment`，并可选读取 `ctx.llm`。整批持久化后投递被拒绝的图片按现有保留规则保持为不可达的内容寻址对象。队列缩略图对每张排队图片增加一次授权附件读取，与会话记录缓存共享。
