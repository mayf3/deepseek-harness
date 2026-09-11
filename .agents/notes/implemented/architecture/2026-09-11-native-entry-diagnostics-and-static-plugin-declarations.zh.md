# Agent Note: 原生条目诊断与静态插件声明

Status: implemented

[English](2026-09-11-native-entry-diagnostics-and-static-plugin-declarations.md) | 中文

## Problem

第三方插件失败后，应用管理入口需要保持可用，同时不能把损坏的必需组合宣布为已就绪。原生 Loader 组会在某行失败后保留成功的其他行。独立的组实现会重复这一行为，而在发现包时检查导出会在用户挂载前执行第三方代码。更新失败后，请求的选项还可能与仍然活跃的 fiber 所使用的已校验配置不同。

## Decision

**启动严格程度由行来源决定。** 只有外部 runtime 组合包引入的行是可选行。内置、boot 阶段、无归属行以及启动 Include 均为必需。profile 的 stage 覆盖作者声明，默认值为 runtime；firstParty 声明与模板来源决定 trust。stage 改变失败策略，不改变执行时间。配置覆盖保留目标行的所有者。嵌套 Include 继承所属条目的来源，不能用其局部 id 查询无关的根级行。

**组合包启停选择整份 patch 层。** 原生行和作者声明的组保留显式 id 与父组。匿名组合包行在独立执行副本中获得确定性的 id。禁用组合包会从所有目标组中移除其插入与覆盖；持久化的用户行覆盖在重新启用后保留。加载前检查所有权：严格层优先占有 id，可选层冲突时整包排除，用户插入冲突时逐行排除。为显式 id 加前缀会破坏作者表达式与用户 patch；依赖作者自行避免冲突则允许 Loader 静默改变父组。

**诊断分别描述操作尝试与运行实例。** `Entry.lastFailure` 在 Loader 已有的捕获或传播位置被动保留导入、激活或更新错误。它不恢复事务，也不改变原生继续加载行为。异步激活失败取自 `fiber.await()`，等待依赖取自注入状态，disabled 表达式失败取自有效条件的求值。活跃的旧 fiber 可以与更新失败同时存在。移除的条目无需独立失败注册表。嵌套延续任务失败仍为提示信息；就绪不保证每个嵌套插件回调均成功。

**重组串行执行且不具备事务性。** launcher 在启动审计前提供 `ProfileRuntime`。准备阶段在修改运行树前拒绝无效文件。已接受的更新等待当前 Loader 工作与已移除 fiber 完成后，发布组合信息并返回问题。必须保留旧 fiber 引用，因为已移除的条目不在 Loader 任务枚举中。某行失败后，其他行已成功的变化保留。新的 patch 副本避免后续覆盖修改其他重组会复用的数据。

**发现阶段只读声明，不执行模块。** `readPackageMetadata` 读取包身份、组合包 patch 和显式 `dsh.plugins` 条目。`.` 表示主入口；子路径与默认配置继续供组合编辑器使用。未声明的包保持已安装和未知状态。声明不证明可导入、Config 有效或激活成功。Cordis 物理 peer 解析仅供提示，无法识别内联副本。运行校验属于每个实际挂载行，包括同一模块在不同预设中的独立挂载。

**未处理的进程级失败仍然致命。** `installFailLoud` 保持到应用关闭。只有条目审计已观测到的重复 rejection 会在其进程检查点内合并。无关的脱离管理 rejection 保留 master 的清理退出策略。进程内的组无法防护 `process.exit`、事件循环阻塞、原生崩溃或 OOM。预设代际的拥有者保留独立的严格挂载与清理行为。

## Alternatives considered

**保留 contained group 和子进程 probe。** [原组设计](../../archived/architecture/2026-09-04-external-bundles-as-contained-groups.md) 防止事务式 Loader 回滚，并为已移除行提供失败记录。原生条目会同时保留成功行与失败行，包装只增加身份，并未提供整层组合所缺少的整包启停能力。[原 probe 设计](../../archived/architecture/2026-09-04-boot-scoped-fail-loud-and-package-probe.md) 为发现阶段的执行设定边界，并发现未声明导出与 schema。静态声明避免这次执行，同时放弃自动主入口识别和挂载前 schema。未来的执行沙箱需要独立设计进程归属与清理，不能把发现 probe 视为运行隔离。

**在 Host 内 import 并 try/catch。** 拒绝，因为发现阶段可能产生不可逆副作用、退出 Host 或阻塞事件循环。捕获异常无法恢复隔离。通过解析源码推断插件导出会增加一个结果不完整的 JavaScript 解释器。

**使用全局必需插件 id 列表。** 拒绝，因为 id 无法描述来源、外部 boot 提供方、自定义 profile 或嵌套 Include 树。已有的 profile trust 与 stage 声明负责这些区别。

**通过回滚全部实时更新或忽略所有启动后 rejection 恢复。** 插件副作用发生后，两者都不能保证恢复安全状态。逐行结果与保留的用户选择可以被观测；进程级脱离管理失败无法可靠归属到某行，因此仍然致命。

## Consequences

已安装元信息、启用层选择与当前运行健康相互独立。启用的组合包可能部分运行、等待依赖或失败；行更新可能保留旧行为并显示诊断。整包禁用移除其 patch 效果，无需合成父组。可选提供方失败导致必需消费方等待时，启动仍可能失败。旧 probe 记录不是激活证据，插件需要显式 `dsh.plugins` 声明才能被发现为可添加模块。

## Verification

`packages/boot/app-boot/tests/entry-issues.spec.ts` 覆盖 trust 与 stage、导入/配置/apply/disabled/pending 失败、嵌套与匿名来源、失败更新后的活跃旧配置、恢复及已移除 fiber 的清理等待。组合测试覆盖重复归属与父组保持。静态元信息测试使用导入时写文件的 fixture，确认未执行、保留未知包并拒绝无效声明。inventory 测试直接验证 Loader 失败与组合冲突，不依赖历史失败注册表。进程处理与用户 patch 测试保留脱离管理失败的致命策略，以及尽力执行的实时重载诊断。

[管理器与 Remote 的拆分](2026-09-04-plugin-manager-over-the-profile-runtime.zh.md)继续适用。管理器集成测试覆盖未知包保留、静态声明、逐行启用结果、保留原归属的失败覆盖，以及依赖恢复后的运行变化通知。
