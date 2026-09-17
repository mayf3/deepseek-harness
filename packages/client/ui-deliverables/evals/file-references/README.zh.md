---
description: "供提示词维护者使用的文件引用提示词评测输入、人工 rubric 和保留的开发评测结果。"
kind: "package-reference"
---

# 文件引用提示词评测

[English](README.md) | 中文

## 摘要

这份包内评测使用四个未修改的开发任务比较文件引用指导。它保留 A/B/C、最终冒号标签版、计数规则、任务 rubric 和历史失败。真实模型运行由人工触发；现有包测试和 Web Session 快照负责无密钥产品回归。运行器和汇总器使用 Python 标准库；评测提示词通过普通插件进入已记录的系统提示词。

## 目录

- [运行一组评测](#run-a-cohort)
- [评审与汇总](#review-and-summarize)
- [保留的结果](#preserved-results)
- [开发者笔记](#dev-note)

<a id="run-a-cohort"></a>
## 运行一组评测

需要 Python 3.9+、提供 `ps` 的 POSIX 主机、Node 和仓库依赖，以及已构建的检出目录（`pnpm run build`）。从仓库根目录执行。通过 `--env-file` 指定正常使用的 DSH 环境文件，或继承其环境；运行器不读取凭据值。`--model` 必须显式提供，使用 DeepSeek provider 和 high 推理强度。每次尝试使用新的 DSH home、agent home、Session 和 HEAD 归档工作区；可执行程序是本检出目录构建的 `dsh --profile headless` 启动器。

执行一次真实冒烟验证时，将 `DSH_EVAL_ENV` 设为正常环境文件路径，然后运行：

```sh
python3 packages/client/ui-deliverables/evals/file-references/run.py --variant a-colon --case plan --repetitions 1 --model deepseek-flash --env-file "$DSH_EVAL_ENV"
```

省略 `--variant`、`--case` 和 `--repetitions` 即使用原三版、四个任务和三次重复。`--prepare-only` 只记录输入，不调用 API。默认每次尝试上限为 480 秒，可用 `--timeout` 缩短。运行串行执行，遇到首次失败即停止；重试或恢复不会替换输出。打印的目录位于被忽略的 `.artifacts/file-reference-evals/` 下，保留输入哈希、源码归档、输出、工作区、Session 和失败。指定的 `--output` 必须是 `.artifacts/` 内的新目录；缺失的父目录会自动创建。运行器回收启动器，并等待进程组的所有成员终止；等待父进程回收的僵尸进程不计为仍在运行的工作。

可移植运行器使用正常的只读 sandbox 和 never approval 策略。评测文件会从任务工作区移除，但宿主、运行时和网络资源仍共享，因此不是完全隔离环境。应检查记录的工具活动中是否存在工作区外访问。它的控制措施与历史 R3 的 macOS 专用防护及并行调度不同；只在新组内比较，不与 R3 合并统计。归档固定 HEAD 源码，启动器哈希标识构建；运行时代码变化后应重新构建。评测文本保留内嵌换行，并省略正式提示词段开头的产出提醒，因此评测文本与正式段落并非逐字节相同，组内指标不衡量该完整段落。

<a id="review-and-summarize"></a>
## 评审与汇总

依据 [rubric.md](rubric.md) 检查完整首答和保留的工作区。评审与执行分开；rubric 内容不传给模型。引用是否应计数、目录是否多余、是否有歧义及事实依据都需要人工评审。保留每次运行的引用和任务台账，再按 rubric 写入绑定答案哈希的 `annotation.json`。未经评审的回答保持未评审；缺失回答不计为完美回答。

汇总器接受打印的运行目录，或已提交的历史观察数据：

```sh
python3 packages/client/ui-deliverables/evals/file-references/summarize.py packages/client/ui-deliverables/evals/file-references/results/2026-09-16/observations.json
python3 -m unittest discover -s packages/client/ui-deliverables/evals/file-references -p 'test_*.py' -v
```

它验证非负计数、E = L + M + I、重复尝试和新答案哈希，并报告计划数、尝试数、回答数、缺失审计、有效链接覆盖、已审计完美回答和超时。它不自动推断遗漏的文件提及，也不判断语义正确性。这些无密钥 Python 检查在 Linux PR CI 作业中验证评测工具、历史输入哈希和进程清理。包的常规 Vitest 测试校验最终冒号评测文本与正式指导的一致性，以及每份 Web 提示词 sidecar 中的指导。不增加真实 API CI 作业。

<a id="preserved-results"></a>
## 保留的结果

[R3 表格](results/2026-09-16/metrics.md) 保留全部 69 项原始指标和任务 rubric。[观察数据](results/2026-09-16/observations.json) 可复算核心计数，并包含超时。[限制及后续运行](results/2026-09-16/notes.md) 将冒号修订和指定格式的录屏单列。原始首答、完整 Session、认证日志和原始审计台账保留在私有实验归档中，不进入此包或其 npm tarball。历史聚合计数支持复算；没有原始记录时，不支持独立重新审计。

<a id="dev-note"></a>
## 开发者笔记

[文件预览决策](../../../../../.agents/notes/implemented/feature/2026-09-15-markdown-file-preview-links.zh.md) 负责提示词选择。本目录负责可复用评测输入和方法；仓库 `benchmarks/` 负责跨包性能门禁。
