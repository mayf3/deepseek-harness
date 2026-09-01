# Agent Note：job 注册表吸收观测 record；独立的 activity seam 被移除

Status: implemented

[English](2026-09-01-jobs-absorb-activity-record.md) | 中文

## 问题

[activity 观测 seam](../feature/2026-08-24-activity-observation-seam.zh.md) 把实时输出流做成了 `ctx.jobs` 旁边的第二个注册表：生产者要把同一份工作登记两次（job 管生命周期，activity 管观测），手工保持两个终态一致（`observeBackgroundActivity` 要等 `proc.done` 才映射 outcome，防止 pump 失败把错误终态冻上去），通过 `ActivityCorrelation.jobId` 关联两行，并给每个观测调用包上注册表缺失的降级分支。Web 客户端维护两份名册（session-control 的 `jobs` 帧与 activity control 流）并逐行做 join。合并前实测：八个配对调用点；生产者人口为——后台 bash/pwsh（双注册表）、PTY 发送与 subagent 委托（仅 jobs）、前台 workflow（仅 activity）。

唯一没有 job 的 activity 是前台 workflow 镜像。拆分带来的其他一切——独立观察者、绝对偏移读取、有界保留——都是 record 的性质，不是注册表拆分的性质。

## 决策

`ctx.jobs` 拥有观测 record；`packages/activity/`、`packages/api/activity-controller` 与 correlation 词表被移除。

- **`JobStart.record?: true`** 声明可观测输出 record。`run(job)` 现在收到 job 的生产者面——`RunningJob { id, append(text, {channel?, gapBefore?}), updateDetail(detail) }`——因此 id 在 starter 运行前签发（starter 抛出仍然不登记任何东西；序号被跳过）。starter 内暂存的写入在登记提交时可见。`updateDetail` 对所有 job 可用，让 `job_list` 也能看到实时进度行；未声明 record 的 `append` 记日志并丢弃。
- **没有 `end`。** job 结算——生产者 outcome、kill 或 teardown——是 record 唯一的关闭：裁剪到结算保留量并发出最后一个 `onOutput` 信号。双结算配对（`ActivityHandle.end` 与 teardown 强结的 first-wins 对账）被删除，而非重新实现。
- **`readRecord(id, from, caller)`** 是非消耗多读者视图（绝对 UTF-8 偏移，低于保留窗口为 `lossy`），围栏与其他 job 读取一致；永不置 `reported`。模型面的 `readOutput` 游标原样保留——两个投影服务不同读者，刻意保持分离。
- **`jobs-local`** 吸收块环（`retainBytes` 运行期 256 KiB，`settledRetainBytes` 结算后 16 KiB），`pumpJobOutput` 在 seam 旁替换 `pumpActivityOutput`。生产者把 pump 的末次排空折进 `hooks.done`，让 record 在结算关闭前握有最后的字节。
- **wire 移入 session 命名空间。** `SessionJob.outputTotal`（恰在 record job 上存在）标记行可观测；`session.observeJob({sessionId?, jobId, from?})` 流式发送 anchor/output/status 帧，围栏读取者由请求的 session 解析——与 killJob 相同的授权形态。`api-activity-controller` 删除；其名册流是冗余的（jobs 帧就是名册），observe 机制移入 `session-controller`（`observe-job.ts`，客户端 `ctx.jobOutput`）。
- **`ui-activity` 改回上游名字 `ui-jobs`**，渲染单一名册：`jobsBySession` 行，恰在 `outputTotal` 存在时可展开。双名册 join 被删除。
- **前台 workflow 有意失去实时面板。** `tool-workflow` 的 activity 镜像被移除；前台 run 只通过已记录的 run/member 生命周期事件呈现，逐行的 `workflow/phase` / `workflow/log` 叙述在 workflow 获得 `run_in_background` 并登记 record job 之前没有观察者。jobs 保持纯后台注册表——没有 `foreground` 模式位、没有模型不可见行、没有无 run 行。

## 已否决

- **`foreground: true` job 模式**以保留前台 workflow 面板：它需要两个耦合的执行点（出生即 reported 与 `job_list` 过滤），两者一旦分叉就会双投递或向模型泄漏行，而它换来的只是一个可被 `run_in_background` 替代的边缘特性。
- **用 record 服务模型读取**（删除 `readOutput`）：模型读取是生产者格式化的（截断与 spill 提示、sandbox 标记）且消耗型；record 是原始、带 channel 标签、非消耗的。统一二者要么把生产者特有格式化搬进注册表，要么把噪声混入观察者流。
- **保留拆分但共享实现**（公共注册表库）：它消除重复骨架，但保留真正的成本——双重登记、终态配对、correlation、第二条 wire 名册与第二个包族。

[先前 seam note](../feature/2026-08-24-activity-observation-seam.zh.md) 反对用持久会话事件或 control 流承载实时输出的论证仍然成立并原样沿用：record 是进程本地观测状态，从不是会话事件，「模型可见 ⟺ 已记录」不受影响。

## 后果

每个可观测行都是可 kill 的 job；没有生命周期的纯观测面需要新的归属（harness 诊断属于 inspector 平面，不在这里）。未来的远端 job provider 必须同时实现生命周期与 record。record 的保留配置在 `jobs-local`；观测 wire 的节奏配置（`observeFlushMs`、`observeMaxFrameBytes`）在 `session-controller`。
