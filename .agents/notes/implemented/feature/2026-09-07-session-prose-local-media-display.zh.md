# Agent Note: 会话正文本地媒体路径通过同源文件路由显示

Status: implemented

[English](2026-09-07-session-prose-local-media-display.md) | 中文

## Problem

Assistant 正文有时用本地文件系统路径引用图片（markdown `![](/Users/.../x.png)`）。Web 渲染器只允许绝对 HTTP(S) 图片目标，这类引用只能回退为惰性 alt 文本：浏览器读不到 Host 文件，也没有任何东西提供这些字节。检索正式与外部 Issue 仓库均无既有记录，issue #3662 记录了这一缺口（Web 无法显示 Agent 回答引用的本地路径图片）。

## Decision

会话正文中的本地媒体路径通过一条同源文件路由渲染；重写词表与服务政策分别归属于仓库现有缝对应的位置。

- **渲染缝（`ui-primitives`）**：`MarkdownText` 新增 `MarkdownPathImages` 词表（`pathImages` prop），与 `fileMentions` 同用 settled-only 门：消息流式期间冻结的缓存块绝不烘入词表处理器；落定渲染把未通过远程 URL 白名单的图片目标重写为可展示 URL，且只有结果是绝对 `http(s)`/`blob`/`data` URL 时才发射。不提供词表时渲染输出与之前逐字节一致。
- **聊天接线（`ui-chat`）**：`AssistantMarkdown` 提供页面级稳定的词表，把绝对 POSIX 路径映射为同源 `GET /api/file?path=…`（`local-path-media.ts`）；非 HTTP 载体（Electron `file://`）与相对/协议相对目标保持惰性。
- **Host 路由（`session-controller`）**：`SessionMediaReferences` 是与 `SessionFileReferences` 并列注册的插件贡献，把 `GET|HEAD /api/file` 挂到共享鉴权 `connection.fetch` 通道（与 `/api` RPC 同一 trust fence 与浏览器认证）。每次请求 fail-closed：路径必须绝对、其 `realpath` 必须落在已注册 workspace 根内、文件必须是常规文件、扩展名必须在媒体 allowlist 内（PNG/JPEG/GIF/WebP/AVIF、MP4/WebM/MOV/OGG、MP3/WAV/Ogg/M4A/AAC/FLAC）；图片扩展额外校验字节签名。响应以 HTTP Range 流式输出（206/416），视频/音频可拖动进度，并携带 `private, no-store` 与 `nosniff`。该贡献只在 `connection` 与 `workspaceRegistry` 均被组合时激活（pending-until-composed，与包内其它可选贡献一致）。

该路由纯呈现且无状态：从不写入、不跟随重定向，失败返回 400/403/404/415/416，不近似其它文件服务行为。

## Alternatives considered

- **注册到 Typert gateway**：gateway 负责 Remote RPC 分发（endpoint 认领、WebSocket mux、转发事件），不负责文件服务；把路由放那里等于把 workspace 文件的 HTTP 呈现塞进 RPC 传输层。否决并完整回滚。
- **注册到 `workspace-controller`**：该包负责 workspace 注册表生命周期（CRUD、排序、feed），与文件呈现只共享 registry 这一政策数据源。否决并完整回滚。
- **经会话 RPC 取字节后显示 blob/data URL**：附件图片已如此工作，但 markdown 重写需要渲染时确定性同步 URL（流式冻结缓存、memo 化）；异步往返不能成为渲染缝。否决。
- **逐图片或仅图片专用路由**：媒体类型共享同一条「路径 + 包含」政策，视频/音频本就需要 Range 流式；一条 `/api/file` 路由加扩展名 allowlist 即可覆盖现有与后续媒体类型。作为更窄的方案被否决。
- **手写 MIME 表、Range 解析与图片签名校验**：否决，改用维护中的包（`mime-types`、`range-parser`）且不做嗅探。其中字节签名校验被否决的理由是：相同检查已在 `fs/tool-fs` 的 `read_image` 工具内实现，仓库的跨文件克隆门禁止在此复制，而为单个辅助函数加宽 attachment 包公开 API 没有共享归属。扩展名 allowlist 已把非媒体内容挡在门外，损坏的图片载荷失败发生在浏览器侧而不是路由上。
- **每请求交互授权、客户端协商端点或任意 Host 路径**：重写只是呈现；路由对每次请求复验，可读字节限制在注册 workspace 根与 allowlist 媒体内；同源端点是固定通道契约而非协商能力。出于安全与确定性否决。

## Consequences

- 引用 workspace 内图片文件的 Assistant 正文现在可在 Web 聊天中显示；原先惰性的 alt 文本只在 Host 无法提供字节时保留。
- 政策在 Host 端每次请求强制；客户端词表不会扩大路由放行的范围。媒体类型判定信任扩展名 allowlist；字节签名校验保留在其所有者 `read_image` 工具中。
- 范围刻意收窄：只服务注册 workspace 根内、媒体 allowlist 内的文件；其它一律保持作者原样的回退。Trajectory 与工具卡片等 markdown 消费方尚未传词表，视频/音频 markdown 节点也尚未渲染为 `<video>`/`<audio>`——URL 层已为它们准备好。
- 客户端把 `/api/file` 硬编码为同源通道契约；由于页面与挂载路由的 Host 同源，该契约按构造稳定。
- 相关历史：已归档笔记 [model-readable image paths](../../archived/feature/2026-08-21-model-readable-image-paths.md) 决定本地图片路径面向模型的一侧；本笔记拥有面向用户展示的一侧，不构成对其的取代。

## Testing

单元覆盖：渲染缝（落定与流式门、引用式图片、协议复检）、聊天词表与组件接线、Host 路由政策（包含关系、符号链接、媒体 allowlist 与签名不符、Range 解析与 206/416 应答、HEAD、插件贡献的释放）。开 PR 时的本地证据：typecheck 干净；ui-primitives、ui-chat 与 session-controller 套件（103 个文件、1456 个用例）全过。推迟到 PR 后续：端到端 GUI 路径的 keyless 录播回放，以及 GUI PR 证据链要求的浏览器演示 GIF。
