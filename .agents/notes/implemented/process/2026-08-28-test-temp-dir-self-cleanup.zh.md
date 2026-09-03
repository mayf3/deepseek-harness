# Agent Note：单测删除自己创建的 dsh-* 临时目录

Status: implemented

[English](2026-08-28-test-temp-dir-self-cleanup.md) | 中文

## Problem

测试进程用 `mkdtemp(join(tmpdir(), 'dsh-*'))` 创建 `/tmp/dsh-*` 目录后不清理。在自托管 Linux CI 主机上（32 个 runner 实例共享一个 `/tmp`），残留两次耗尽根分区 inode（issue #3134，2026-08-13 与 2026-08-26）。机器侧 `dsh-tmp-sweep` timer 与 CI lane sweep（保留未合并，在分支 `fix/ci-tmp-residue-cleanup` 上）都是事后删除残留，未修掉产生残留的缺陷本体。人类 review #3233（2026-08-28）否决了 sweep：单测应改为自己清理创建的目录。

## Decision

为 spec 文件创建的每个 `dsh-*` 临时目录补上删除路径，挂在所属测试的 teardown 上：

- 创建目录但从不删除的 spec 文件，现在把每个创建的 root 记入模块级列表，并在 `afterEach`/`afterAll` 里删除（`rm`/`rmSync` 带 `recursive: true, force: true`）——与 session 包既有的 `roots.splice(0)` 约定一致。创建 root 的 helper（`tmp()`、`tempDir()`、`fakeLauncher()`、harness 函数）在创建处登记，一个点覆盖全部调用方。
- 整文件共享的模块级 fixture 目录（executor spill 目录）在最后一个测试之后的 `afterAll` 里删除。
- 目标文件清单来自 CI 主机上的残留实测清单（当前 `/tmp/dsh-*` 目录的模板直方图）：只有目录确实出现在残留里的 spec 文件才是泄漏源。已有删除逻辑的文件（agent-team、tool-subagent、list-children、hooks coverage cases）确认在正常结束路径上本来干净，不改。
- 产品侧每进程 spill root（`dsh-subprocess-local/spawn` 的 `privateSpillDir`、`dsh-spill-local/store` 的 `privateRoot`）注册 `process.once('exit')` handler，在进程正常退出时删除记忆化的目录——凡走过 spawn/spill 路径的进程都会在正常结束时清理。

## Verification

- 本地定向跑过全部改动 spec（32 个文件、700 个测试）通过，含直接使用改动后产品源码的套件。
- CI 在 Linux 与 Windows coverage lane 跑改动 spec；一次全绿后，被修文件的残留模板（实测每两小时最多各约 5,000 个目录，如 `dsh-profile-`、`dsh-app-boot-`、`dsh-presets-*`、`dsh-upload-index-`）应不再出现在 CI 主机的新鲜 `/tmp` 残留里。

## Alternatives considered

### 保留纯 sweep 方案（review 否决）

Sweep 步骤与 timer 只删已存在的残留；本地运行仍会累积，机器 sweep 也区分不了已死 run 的残留与存活 run 的目录。review 的决定是逐测试清理，本实现覆盖正常结束路径。

### 引入共享临时目录 helper 包

未选：泄漏文件各自通过自己的小 helper 创建 root，在那些 helper 处登记是每个文件单点改动；新增 test-support 包只会增加依赖，不减少逐文件审计量。

## Consequences

- 收益：正常结束（含测试失败）时，spec 的 `dsh-*` 目录在 teardown 删除；每进程 spill root 在其进程正常退出时删除。
- 代价：被 SIGKILL 的进程（run 被取消、超时被杀）无法运行任何进程内 teardown，飞行中的残留仍在——机器侧 timer 继续兜底该路径。
- 代价：子进程创建的目录只有在测试知道其路径时才被覆盖；产品自有每进程 root 由创建它的进程的 exit handler 覆盖。
