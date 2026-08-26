# Agent Note：人工任务终止——用「未认领的终态报告」而非第二条取消路径

状态：已实现

[English](2026-08-26-human-job-kill.md) | 中文

## 问题

[Web 任务展示 Note](2026-08-08-web-background-job-display.zh.md) 把任务列表交付为只读并记下了原因：`JobRegistry.kill()` 会把任务标记为 `reported`，而 [`dsh-tool-jobs`](../../../../packages/jobs/tool-jobs/README.zh.md) 的完成播报员对已 reported 的任务抑制结算通知。这个耦合对当时唯一的调用方是正确的——模型的 `job_kill` 自己的 tool result 已经告诉模型它做了什么——但按下停止按钮的人没有任何模型可见渠道。照那份契约写一个人工 kill，模型会一直以为任务还在跑，正是 Claude Code 今天在售的过期世界模型失败（其 `/tasks` kill 置 `notified: true`，模型什么也学不到），也正是 Kimi 避开的（模型 `TaskStop` 抑制自己的通知；人工 stop 投递一条）。

## 决策

`reported` 位的本义是「终态已有一条向模型送达的承诺路径」，所以修法是不再把「取消」与「认领这次送达」混为一谈。

- **`kill(id, caller?, options?)` 接受 `{ reason?, reported? }`。** `reported` 默认 `true`——即模型 `job_kill` 的原有语义。`reported: false` 只是不提出本次 kill 的认领，结算随即照常走完成播报员（唤醒/注入、唤醒预算、截断全部不变）。它绝不清除已有认领：模型已 kill 过的任务保持 reported，终态记录也保持结算时的原样。
- **记录下来的 kill reason 合入 `killed` 结算的 detail**——生产者事实在前（`signal: SIGTERM; cancelled by the user`）——完成通知与 Web 行因此都能说清是谁停的工作，无需新快照字段或新通知模板。跑赢 kill 的任务（结算为 `completed`/`failed`）只保留生产者 detail。这正是 Codex 在 `<turn_aborted>` 指引里写明的对账原则：用户停掉了什么，要告诉模型，而不是让它去猜。
- **`session.killJob` 是 Session Controller 的 Remote**，与 `cancel` 并列，同样只查活体 Agent（`ctx.agents.get`）：按注册表的所有权契约，在跑任务的 owner 必然活着；从列表里 kill 与列表本身一样绝不复活 Session。未知与他人任务合并为一个只作用于查找的 `job-not-found` 拒绝——生产者 cancel 抛错按注册表契约原样传播，绝不伪装成查找失败；没有 `ctx.jobs` 的组合拒绝 `jobs-unavailable`，服务级的 subagent 所有权栅栏与 `cancel` 完全一致地适用。不加 approval 交互：这个单用户本地 BFF 把它视为与停轮按钮同级的操作。
- **任务列表的停止控件为两击式**（先武装、3 秒内确认，对齐 Kimi 的 `s`+`y` 与 OpenCode 的双 Esc），只渲染在运行中的 job 行——即带 `jobId` 的行。独立 activity 行（workflow 运行）没有 kill 句柄也就没有按钮。请求进行中按钮禁用，且受理成功后保持 pending——unary 响应与 jobs 帧没有跨载体顺序保证，只有权威帧（行离开可杀集合）才释放控件；被拒绝的 kill 短暂提示。由于 kill 按 id 寻址 `ctx.jobs`，所有任务 kind 一次性获得该控件——bash、pwsh、pty 与一次性后台 subagent。

## 备选方案

- **`notify: boolean` 选项**——否决：注册表承诺不了通知（quiet 投递、无主任务、owner 拆除都会正当地丢弃一条）；`reported` 命名的是注册表真正控制的事实，用的是 `JobSnapshot.reported` 已有的词汇。
- **独立的 `interrupt()`/`stopByUser()` 方法**——一条取消路径带显式认领胜过两个只差一个布尔的方法；Kimi 的拆分（`stop` 与 `stopByUser`）上线时 TUI 就调错了那个。
- **对模型保持沉默（Claude Code 的形状）**——否决；他们自己的源码注释都在质疑它，而 DSH 的阻塞 Note 正是把过期认知失败记为该控件此前不能上线的原因。

## 测试

`jobs-local` 钉住不认领 kill（通知仍欠、既有认领存续、终态记录不动）、`killed` 的 detail 合并与跑赢 kill 的情形；`tool-jobs` 逐字钉住带原因的投递通知文本。`kill-job.host.spec.ts` 钉住 Remote 命令：受理、无 agent 会话 kill 无主任务、未知/他人的 `job-not-found`、无注册表的 `jobs-unavailable`。客户端套件钉住 RPC 透传与两击控件（武装、确认、解除计时、失败提示、单一武装行、过期相位清理）；无密钥 web e2e 端到端驱动按钮。

## 后果

- 人工 kill 的完成通知会唤醒空闲 owner（默认 `wakeup` 投递）——这是刻意的代价：模型永远学不到的未认领完成，正是本 Note 要修的失败。
- `kill` 的位置参数 `reason` 已删除（pre-release，无垫片）；options 对象是唯一形式。
- 被 kill 任务的 `detail` 可能携带以 `; ` 连接的两个子句。任何把 `detail` 当单一生产者事实解析的代码都必须把它当不透明文本——`JobSnapshot.detail` 一直如此声明。
