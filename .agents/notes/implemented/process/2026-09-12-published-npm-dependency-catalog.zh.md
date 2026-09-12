# Agent Note: 已发布 npm 包的依赖目录

Status: implemented

[English](2026-09-12-published-npm-dependency-catalog.md) | 中文

## 问题

README 运行 `npx @deepseek-ai/dsh web`。Workspace 包列表和开发用 lockfile 无法确定 npm 为该命令解析的包：已发布的 `latest` tag 可能不同于源码版本，npm 会自动安装必需的 Peer 依赖，各包的版本范围也可能独立于 CLI（命令行界面）版本解析。

## 决策

[依赖目录](../../../../docs/dependency-catalog.zh.md)记录已发布 CLI 的完整 npm 依赖解析结果。[生成器](../../../../scripts/gen-dependency-catalog.ts)要求 npm 在临时消费项目中仅解析 `@deepseek-ai/dsh@latest`，并禁用安装脚本。提交的 npm lockfile 和解析元数据保留 registry、采集时间、工具版本及宿主平台。普通生成和 `doc-sync`（文档同步门禁）使用确定性的英文、中文及配对记录内容进行比较，无需访问网络。

目录保留嵌套版本和重复的包安装位置，排除仅用于开发的条目，并区分直接依赖、传递依赖、自动安装的 Peer 依赖及可选候选项。包的平台声明仍然可见。可选依赖安装失败、可选祖先路径、安装脚本下载、npm 配置，以及现有本地安装或缓存，使静态记录无法承诺每台宿主机上的安装完全相同。

[第三方声明决策](2026-07-30-generated-third-party-notices.zh.md)仍然有效：声明披露已分发插件和浏览器 bundle 的许可证，目录则记录默认 npm 安装中的包。两份清单互不替代。

## 考虑过的替代方案

**遍历 workspace manifest 或 pnpm lockfile。** 它们描述源码开发环境，可能包含未发布包、构建依赖，以及 npm 不会选择的解析结果。

**每次文档检查都访问实时 registry。** Registry 变化会使无关 PR（Pull Request）失败，并使同一提交产生不同文档。显式刷新替换记录的解析结果，普通检查保持离线。

**将所有解析条目列为无条件安装。** npm 会记录多个平台的可选包，可选安装也可能失败。目录标明这些候选项，并说明仅生成 lockfile 的证据范围。

## 影响

读者可以查看最近记录的公开发布版本对应的精确解析版本，贡献者可以用一个命令刷新记录。采集时间显示证据的获取时点；新鲜度检查证明生成内容与提交的解析结果一致，不证明 npm 的 `latest` tag 未发生变化。定向测试覆盖运行时依赖筛选、嵌套版本、别名、Peer 依赖、可选平台条目，以及过期的生成文件或译文。
