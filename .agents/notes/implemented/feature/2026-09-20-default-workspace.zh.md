# Agent Note: 首次使用默认 Workspace

Status: implemented

[English](2026-09-20-default-workspace.md) | 中文

## Problem

新安装的应用要求用户先选目录才能发送第一条消息。去掉这一步前置操作时，必须保留 Session 的固定工作目录，也不能把隐藏或已归档的历史误判为新安装。

## Decision

会话外壳保存未发送的本地文本草稿，不创建 Session。首次发送请求 Host 准备默认 Workspace，随后连接真实 Session，并通过常规 composer 流程提交。首次使用的草稿会在自动提交前等待暂存的模式选择完成。这部分取代[Session scope 与供给通道](../architecture/2026-07-25-web-client-session-scope-and-provide-channel.zh.md)中无 Session 时锁定 composer 的决策；该记录仍负责 blank Session 复用与供给通道的理由。

[Workspace registry](../../../../packages/workspace/workspace/README.zh.md#first-use-workspace)负责资格判断和目录准备。所有 live Session、持久化 header 和已归档身份都计入判断，包括侧栏中不可见的条目。操作共用 registry 修改队列，并在目录准备后重新检查 Session 历史，因为 Session 可以独立启动。

Client 在发送时按其语言解析初始目录名和标题。Host 控制器解析 Documents 位置；注册表接收不依赖 locale 的目录解析器。解析器仅在允许创建时于变更队列内运行，因此重复请求直接复用持久化的 Workspace，无需再次查询操作系统目录。持久化 Workspace id 独立于名称记录初始化成功。改名、切换语言、重启或删除登记均不能再次初始化默认工作区。标记与登记一起提交，因此登记失败可以重试。目录内容仍遵循已有的[仅删除元数据策略](2026-07-27-workspace-registration-deletion.zh.md)。

创建失败时保留草稿，并提供现有文件夹选择器。成功的登记会在 Session 创建或提示词发送失败后保留。失败后选择文件夹只转移文本，不发送；随后发送仍由用户操作。

## Alternatives considered

- 在应用启动时创建，会为从未发送消息的用户写入目录。
- 根据侧栏可见行推断首次使用，会忽略已归档、隐藏和无 cwd 的 Session。
- 将本地化路径作为初始化标记，会允许切换语言或删除后再次创建默认工作区。
- 在 Session 创建后更改 cwd，会改变其已记录工具和附件的含义。

## Consequences

首次使用时输入文本不会产生 Host Session 或文件系统副作用。Desktop 和远程 Web 客户端均由 Host 准备目录，因此远程用户使用 Host 账户的 Documents 位置。Documents 查询不可用时，采用与目录创建失败相同的文件夹选择恢复路径。

该功能保留[由引用持有的 Client Session 生命周期](../architecture/2026-09-15-client-session-references.zh.md)，无需修改 agent-loop 或 Session 事件。Registry 和客户端测试覆盖重试、隐藏历史、并发及草稿恢复；[浏览器场景](../../../../apps/web/tests/default-workspace.e2e.ts)通过隔离的 Documents 目录和已录制 Session 回放验证完整装配下的首次发送与选择器路径。
