# Agent Note：唯一的 shell execute()——前台是投影，超时是转移 offer

状态：已实现

[English](2026-08-26-shell-execute-timeout-promotion.md) | 中文

## 问题

跑过前台超时的 bash 命令会被杀掉、工作作废——这是长构建或安装在 agent 手里失败的头号方式。在旧 seam 里修它结构上很别扭：`ctx.shell` 有两个执行方法，`run()`（deadline 内置、只给 promise、没有可保留的句柄）与 `start()`（有句柄、无 deadline），于是「保住这个已在运行的前台命令」无从表达——deadline 的所有者只会杀，调用方也拿不到可向 `ctx.jobs` 重新注册的东西。两个方法还各自漂移：stdout 预算不同、文档里挂着「start 忽略 timeoutMs」的疣、同步与异步 spawn 失败的行为按路径分叉。

同行证据指向同一个方向。Kimi 默认超时即转移（`bashAutoBackgroundOnTimeout`），什么都不重绑——process task 脱管、调用方信号解钩、部分输出随句柄返回。Claude Code 的超时处理器对同一个 `ShellCommand` 调 `background()` 而不是杀，注释明言重新 spawn 会泄漏清理回调、重复事件。Codex 没有转移，因为它压根没有「前台 spawn」：每次 `exec_command` 都是 session 之上的有界观察窗，「还在跑」是携带句柄的正常返回。三家在底层形状上一致：执行只有一种，前台是等待的属性，不是 spawn 的属性。

## 决策

**seam 收敛为 `resolve()` + `execute()`。** `execute(spec)` 返回 `ShellExecution`——活的 `ShellProcess` 本体加两个投影：`result()`（前台视图：分流收集、首因 `timedOut`/`aborted` 归类、只为基础设施失败 reject）与 `promotion`（deadline 的先到者信号）。`run()` 与 `start()` 删除（pre-release，无垫片）；它们编码的历史差异变成显式输入：`ShellExecSpec.onExpiry` 取 `'kill'`（默认）、`'offer'` 或 `'none'`，stdout 预算统一为 `spec.stdoutMaxBytes`。

**`promotion` 恰好结算一次且绝不 reject**：`'offer'` deadline 在进程仍在跑时到期则给出 `ShellPromotionOffer`，进程先结束（以及其余每种策略下）则给出 `undefined`。这份完备性让消费方能写 `const offer = await ex.promotion` 而无需与 `result()` 竞速。offer 必须在 resolve 的同步段内应答；未应答由执行器自动 decline，失效方向是旧的超时杀，绝不是悄悄脱管的进程。`accept()` 终止 deadline 义务并解绑调用方的中止信号（Kimi 的 `detachEntry`、Claude Code 的 `#cleanupListeners`，同一手法）；`decline()` 立即杀并归类 `timedOut`。

**spawn 失败统一收容**：同步抛错与异步 rejection 都把句柄结算为 `killed`、说明进入读路径，而 `result()` 以原始错误 reject（保留同一性——沙箱执行器在其 `result()` 装饰里把可归因于 runner 的失败映射为 `SANDBOX_UNAVAILABLE`，并在 `onProcessDone` 里盖章句柄事实，两者都以同一个句柄实例为键）。

**`tool-bash`/`tool-pwsh` 默认超时即转移**（`promoteOnTimeout: true`，要求 `enableRunInBackground` 与活的 `ctx.jobs`）。阈值就是现有的 `timeoutMs`——到期成为触发器，与 Kimi 和 Claude Code 的重定义完全一致；不存在第二个旋钮。收到 offer 时，工具用与 `run_in_background` 相同的三个钩子把在跑句柄注册为任务、镜像进 `ctx.activities`（Web 任务列表随即可流式观看，含停止控件）、做一次消费读嵌入结果，返回 `{ kind: 'promoted', jobId, timeoutMs, output }`，渲染为 `[still running after <ms>; moved to background job <id>]` 加交接指引。游标恰好从嵌入输出之后接续——Kimi 的形状；Claude Code 只回文件指针是因为其输出身份是文件，DSH 的是任务游标。任何转移失败（准入、控制器预检）都 decline 并回落到普通超时杀，且有日志。之后的完成经既有 tool-jobs 通知流动，模型无需轮询即被告知。

## 备选方案

- **在 `run`/`start` 旁加第三个方法（`begin()`）**——最初的设计。评审中否决：三个「方法」其实是披着方法名的两根正交输入（deadline 策略；调用方等待哪个投影），同行产品全都建模为一次执行加投影视图。收敛顺带删掉了预算/疣的漂移，而不是再添一层表面。
- **Codex 的 session 模型**（每次调用都是观察窗、经 `write_stdin` 轮询）——否决：那是重复 `ctx.jobs` 已有能力的模型侧词汇变更；其早退结果契约保留在 promoted arm 里。
- **独立的转移阈值配置**——否决；「超时意味着别再阻塞回合，而不是杀掉工作」不需要第二个计时器，模型显式传的 `timeoutMs` 同样转移（两家同行皆如此；schema 文案已说明）。
- **在 offer 内用状态检查兜底**——在同步应答契约下是死代码；改为微任务自动 decline 加 answered 闩。

## 测试

执行器层（真实进程）：deadline 处给出 offer；accept 解绑计时器与调用方信号（accept 后 abort 不杀、`kill()` 杀）；decline 归类 `timedOut`；先结束则 resolve `undefined`；未应答自动 decline；offer 前 abort 归类 `aborted`；`'none'` 策略归类；同步抛错收容且错误同一性穿过 `result()`（沙箱套件）。工具层：真实的 `printf …; sleep 30` 配 `timeoutMs: 250` 端到端转移——任务注册、activity 带调用关联镜像、游标越过嵌入输出接续、`job_kill` 有效；准入饱和回落并告警；`promoteOnTimeout: false` 保持杀并撤掉描述句；pwsh 以脚本化 offer 镜像。渲染文本逐字钉死。

## 后果

- 每个 `ShellExecutor` 消费方都已迁移：工具、hook runner、tmux-context、e2b fixture 与 webworker 沙箱栈现在都说 `execute()`；执行器测试套件用本地 `run`/`start` 垫片保住场景语义。
- `bash`/`pwsh` 的工具描述与 `timeoutMs` schema 文案已变（模型可见），输出 union 新增 `promoted` arm——recorded-session 快照随之重录。
- 转移后的命令此后完全没有 deadline，与任何后台任务相同；停它靠 `job_kill` 或 Web 停止控件。
- `start()` 时代同步 spawn 抛错逃逸给调用方的行为不复存在：调用方从 `result()`/读路径读失败。沙箱「同步 EACCES 指名 runner」的分类现在以 `result()` rejection 或句柄的 `runnerFailed` 事实呈现。
