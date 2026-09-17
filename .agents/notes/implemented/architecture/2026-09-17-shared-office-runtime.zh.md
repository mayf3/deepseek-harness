# Agent Note: Desktop 与 SDK 共享 Office 运行时

Status: implemented

[English](2026-09-17-shared-office-runtime.md) | 中文

## 问题

SDK 部署需要与 Desktop 相同的 Office 创作库，同时将解释器 payload 保存在只读容器镜像层中。由 Desktop 持有查询工具和构建器，会要求下游载体重复维护依赖锁与路径约定。

## 决策

[`tool-workspace-dependencies`](../../../../packages/skill/tool-workspace-dependencies/README.zh.md) 持有清单校验、解释器路径、安装逻辑和模型查询。它保留在 skill 组中，与 Office 工作流消费者相邻：payload 服务于这些工作流，本包不提供 workspace 实体服务。Desktop 引用本包并保留首次使用时复制安装。SDK profile 仅在载体设置 `DSH_PRIMARY_RUNTIME` 时启用查询和 Office skills；它解析 payload 路径并原位读取。公共 base 与 `sdk-minimal` 不会隐式启用 Office。

[共享构建入口](../../../../scripts/primary-runtime/prepare.ts) 持有 Desktop 目标与 GNU/Linux x64 的下载锁、解压和本机冒烟检查。Desktop 提供输出路径和发布版本，要求包含 Node.js 与 pnpm，并应用签名专用子进程环境。其他载体选择自己的输出目录，也可构建 Python-only payload。现有 `desktopVersion` 清单字段保留名字并记录载体发布版本；`payloadDigest` 区分锁定输入与组件选择。

## 考虑过的替代方案

**将实现保留在 Desktop。** SDK 和容器构建器只需要解释器、Office 资源和查询，却仍会依赖应用打包及签名代码。

**在公共 base 中启用 Office。** base 部署不保证提供内置解释器或资源。显式 SDK 载体配置可以让该要求可见，并保持其他 profile 的行为。

**总是复制到 Harness home。** 复制会重复镜像层内容、要求目标可写，也无法满足预期的不可变载体部署。

## 影响

同一插件生命周期内的并发调用共享成功的工具准备结果。准备失败后可重试；卸载移除工具注册并等待未完成的文件系统工作。复制模式验证暂存替换内容，并在发布失败后恢复原安装。原位模式不写入 payload。路径为绝对路径，返回结果前会检查运行时元数据和所声明的条目。

SDK 配置变更需要重启。缺少 Office 资源会产生启动警告，并使可选的 skill 提供方保持未激活；运行时元数据和解释器是否存在在首次工具调用时校验。Linux ARM64 与 musl 构建仍不在锁文件范围内。跨目标组装校验归档哈希，但需要在目标主机执行；Linux 产物 CI 负责本机 Linux 检查。单元覆盖固定清单、安装与生命周期行为；SDK profile 测试观察可选工具、skill 发现与结果，workspace-dependencies 录制场景固定模型可见的校验错误。
