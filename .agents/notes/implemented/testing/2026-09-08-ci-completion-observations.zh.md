# Agent Note: CI 测试观察完成状态而非主机速度

Status: implemented

[English](2026-09-08-ci-completion-observations.md) | 中文

## Problem

[参考 CI 运行](https://github.com/deepseek-harness/deepseek-harness/actions/runs/34206953049)在外层测试预算耗尽前拒绝了两个异步操作：webhook 创建的 Session 在测试轮询一秒后仍不存在，后台 PowerShell 命令在五秒读取期限内尚未输出内容。两个 API 都没有承诺这些延迟上限。成功的 HTTP 202 响应只确认 webhook 已分发，不代表 Session 已创建或模型请求已接纳。

## Decision

[GitHub 评审浏览器测试](../../../../apps/web/tests/github-ready-review.e2e.ts)先等待确定性适配器收到首个请求，再断言 Agent（智能体）和请求的精确数量。Workspace 创建的延迟屏障证明 HTTP 接纳可以早于这两项观察；屏障委托真实方法，并在 `finally` 中释放和恢复；如果请求本身挂起并超过测试超时，独立的 `onTestFinished` 清理仍会释放和恢复屏障。原有的 Workspace 成员关系、提示词内容、回复以及折叠和展开浏览器预期仍然是判定依据。

[PowerShell 执行器测试](../../../../packages/shell/pwsh-local/tests/executor.spec.ts)先等待 `done`，再读取完整的 stdin 和环境变量输出。启动及消费式读取检查用私有文件屏障阻止命令结束，因此运行状态和未读的后续输出不依赖 sleep 或耗时阈值。部分输出轮询继承 lane 预算。每个创建的 Context 都在使用前登记清理；子进程释放先于私有目录删除。在原生 Windows 上，延迟六秒的命令复现五秒期限失败，而改用完成等待后通过。

外层测试超时仍负责防止挂起。完成状态断言不会仅因操作跨越进程、文件系统或事件循环边界，就额外附带一个更短的性能要求。这扩展了 [subagent 清理预算决策](2026-09-07-subagent-teardown-test-budgets.zh.md)，但不替代其 dispose（资源释放）所有权和原生平台验证要求。[浏览器 e2e 决策](2026-07-24-web-gui-browser-e2e-lane.zh.md)继续负责完整组合浏览器 lane 和录制预期。

[Queue 浏览器测试](../../../../apps/web/tests/queue-actions.e2e.ts)在缩窄视口后观察侧栏已折叠且框架动画已完成，再在一次浏览器执行中读取两张卡片的矩形和声明的内边距。分开的往返可能混合调整前的 Queue 坐标和调整后的输入框坐标，即使两个时刻的内边距都正确。受控的尺寸调整屏障复现了这种不匹配；改用原子观察后，相同对照通过。

[publint 运行器测试](../../../../scripts/publint-all.spec.ts)在 lane 预算内等待异步子进程关闭，而不施加五秒同步 spawn 期限。测试独立检查 spawn 错误、终止信号和退出码。清理在等待前取得子进程和 fixture 根目录，终止尚未完成的子进程，并在删除根目录前等待关闭。延迟启动复现了原来的空退出码失败；强制触发外层超时则验证子进程已经结束，而其根目录仍然存在。

[详情 Session 生命周期测试](../../../../apps/web/tests/details-session-lifecycle.e2e.ts)在关闭状态出现后等待框架已捕获的动画 Promise，再保留宽度为零的断言。完成和取消的过渡都会进入该断言；取消不能让持续非零的轨道通过。暂停真实网格过渡可以复现关闭断言失败，只有释放后才成功完成，而持续一像素的轨道仍被拒绝。

[反馈释放测试](../../../../apps/web/tests/feedback-release.e2e.ts)在选择模型后等待菜单关闭：选择响应仍在传输时，投影标签就可能变化。[排队图片测试](../../../../apps/web/tests/queue-image.e2e.ts)区分乐观预览和持久化行的附件；缩略图捕获发生在接纳和持久化附件响应之后。受控响应屏障固定这两种顺序，独立的测试完成清理即使在超时后也会释放拦截的请求。

[宽表格测试](../../../../apps/web/tests/markdown-wide-table.e2e.ts)等待请求的框架轨道与渲染轨道一致，并等待会话 ResizeObserver 发布当前渲染宽度。两次相同的中间表格宽度不能证明这些输入已稳定。暂停原生过渡和延迟观察回调能够复现过期的溢出读数；故意破坏溢出布局时，未修改的几何断言仍然失败。

### 已构建客户端的导入分类

[master Windows 运行](https://github.com/deepseek-harness/deepseek-harness/actions/runs/34204779455/job/101996934534)还拒绝了 `ui-dockkit` 有意暴露的 CSS 导入。[Node 导入检查](../../../../packages/experimental/webworker-runtime/tests/compile/transform-corpus-check.ts)仅在 Node 针对其 `dockkit.module.css` 报告 `ERR_UNKNOWN_FILE_EXTENSION` 时，才允许这个精确的 bundle。相同入口的其他错误仍然失败，成功导入则报告豁免已过期。这保留了导入检查，同时不要求仅面向浏览器的组件库在裸 Node 中加载样式表。

## Alternatives considered

- 增大生产超时或添加测试重试：两者都无法确定哪个操作已经完成，而且会改变与失败断言无关的行为。
- 用更大的常量替换局部期限：这仍然覆盖未来的 lane 预算，并使正确性依赖主机速度。
- 将 HTTP 202 或进程启动视为成功：两者都不能证明预期模型请求或命令输出已经发生。
- 串行化覆盖率或浏览器套件：这些失败没有证明存在必须对整个套件互斥的共享资源冲突。

## Consequences

在 Workspace 创建前受控暂停，可以用原来的轮询等待复现参考断言。释放屏障并等待请求后，相同浏览器预期通过，无需改写 golden。这些对照证明了同步缺陷，但没有测量历史 runner 的资源争抢。产品行为、生产时序和 CI 调度保持不变。
