# Agent Note: 将实验包隔离在默认产品之外

Status: implemented

[English](2026-09-12-default-product-experimental-isolation.md) | 中文

## Problem

在 npm 上公开可用不意味着实验包属于默认产品。直接 manifest 检查会漏掉依赖别名、传递安装路径、仅声明为开发依赖的运行时导入，以及由配置加载的插件。发布 smoke 会一起安装所有 tarball，因此消费者目录中存在实验包并不能说明默认产品需要它。

## Decision

[`verify-default-product-isolation`](../../../../scripts/verify-default-product-isolation.ts) 在静态 CI 和包 hygiene 中运行。它从所有应用与 Python runtime 出发，遍历运行时依赖、可选依赖和 peer，解析 workspace 与 npm 别名，并按 npm 前缀或仓库目录识别实验包。发布 denylist 的成员关系不影响此分类。

源码检查还读取所选包的运行时导入、安装自带的 profile bundle 列表、bundle patch、随产品提供的 Agent preset，以及声明的配置树。Loader group、insert、Include patch 和禁用的插件行均纳入检查。普通插件配置数据不会被解释为另一个 Loader entry 列表。默认入口缺失会使检查失败。

默认 Web 源码图从实际 HTML 入口中的 module script 出发，包括内联模块和本地引用的 Worker 入口。独立的实验预览可以存在而不加入此图；默认入口导入它时检查会失败。源码中的 Cordis 配置文件引用会将 Desktop patch 纳入同一证明。

[`verify-packed-install`](../../../../scripts/release/verify-packed-install.ts) 从 `@deepseek-ai/dsh` 遍历已安装依赖图，通过解析后的 manifest 名称识别别名和外部传递依赖。开发依赖以及安装在产品旁边的不相关 tarball 不参与遍历。缺失必需依赖会失败；允许省略可选依赖，但其名称不得指向实验包。

此检查执行现有的[实验包依赖隔离规则](../architecture/2026-08-18-experimental-agent-teams-packages.zh.md)。[发布策略](2026-09-12-experimental-publication-denylist.zh.md) 独立决定显式消费者可以安装哪些实验包。

## Alternatives considered

**只检查直接依赖名称。** 别名、运行时源码导入和配置加载的插件可以绕过该检查。

**拒绝任何已安装的实验 tarball。** 发布 smoke 有意安装整个发布族，包括可选启用的包。只有默认入口的依赖图能够回答这些包是否成为产品依赖。

**将全部 Web 源码视为默认入口。** 即使默认 HTML 和运行时导入从未到达独立的实验预览，这也会错误拒绝它。

## Consequences

实验包可以发布而不加入默认安装或组合。源码证明覆盖声明和字面量运行时引用；安装检查进一步验证包管理器解析出的依赖图。任意运行时生成的模块名称仍由组合评审和运行时测试约束，不做静态求值。
