# Agent Note: 每个平台使用一个 Office 引擎

Status: implemented

[English](2026-09-15-platform-office-engines.md) | 中文

## Problem

在可用的原生引擎之外安装 WASM，会为应用下载和安装资源增加第二份 LibreOffice 载荷。[独立 kit 归属](2026-09-14-independent-libreoffice-kit.zh.md)中最初的回退策略要求固定平台的 Desktop 和 Python 分发物也携带这份额外载荷。

## Decision

Harness 依赖 kit API，并使用它按平台筛选的可选引擎依赖。macOS 和 Windows 安装匹配的 ARM64 或 x64 原生包；Linux 安装共享 WASM 包。WASM 的 npm OS 声明为 Linux。provider 不直接依赖 WASM。macOS/Windows 缺少原生引擎时拒绝创建转换器，不会选择 WASM。

Python sidecar 组装仅复制目标引擎及其依赖闭包。wheel 打包和运行时查找要求该引擎存在；迁移后的转换冒烟检查所选 backend。Desktop 在应用资源中携带常规 npm 安装结果。引擎编译、资格验证和发布仍由 kit 仓库负责。

## Alternatives considered

**在每个原生引擎旁保留 WASM。** 这能容忍可选原生包缺失，却会增大每个 macOS/Windows 安装。固定平台分发物改为要求其原生引擎存在且经过测试。

**在所有平台移除 WASM。** 当前 kit 家族没有已发布的 Linux 原生引擎。在 Linux 保留共享 WASM 包，既能继续转换 Office 文档，也无需引入新的原生发布目标。

**将 Python Office 伴随目录设为可选。** 运行时承载共享的 `dsh` CLI 及其 Web profile，而不只有默认 SDK profile。强制携带目标引擎使已安装 wheel 具备完整的内置 profile 集合，并在启动前报告载荷不完整。SDK 和 headless 用户也承担引擎的下载与安装体积。

## Consequences

macOS/Windows 分发物省去 WASM 下载和展开资源。原生包缺失成为必须修复的安装缺陷；转换不会下载引擎。Linux 保留 WASM 的资源和字体要求。kit 的引擎选择测试与真实 npm 安装测试覆盖平台选择；Harness 的 sidecar、wheel 和运行时解析测试覆盖打包要求。新包字节在发布前需要 kit 资格验证和匹配的依赖完整性记录。

[公开 Python 发布工作流](../../../../.github/workflows/python-release.yml)拒绝任何大于等于 100,000,000 字节的 wheel。只选择一个引擎会减少载荷，但不能据此认定运行时 wheel 已满足此限制；npm 引擎发布、本地转换与 wheel 上传资格是不同的验证。
