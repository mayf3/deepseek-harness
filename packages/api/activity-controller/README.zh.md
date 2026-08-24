# @deepseek-ai/dsh-api-activity-controller

[English](README.md) | 中文

架在可选 `ctx.activities` 注册表之上的 Activity Remote 流，附 React-free 客户端模型。纯读面：不启动、不取消任何工作，也绝不触碰模型侧消费游标——wire 路径只读注册表的非消费 offset。

宿主 `ActivityController`（命名空间 `activity`）暴露两个 `@Remote({ mode: 'stream' })` 方法：

- `control(signal)`——一份完整 roster baseline，之后每次注册表变化按 owner 会话推送整桶替换帧（与 session control 流承载 jobs 的自愈形态一致）。没有注册表的组合返回空 baseline。
- `observe({ activityId, from? }, signal)`——一帧 `opened` 锚点，随后是合并的 `output` 帧（`flushMs` 窗口、`maxFrameBytes` 软预算；更大的单 chunk 整帧发出），activity 结算且排干后发一帧终态 `status`，然后本代正常关闭。重连方以上一帧的 `next` 作为 `from` 续传；落后于保留窗口的续传会带 `lossy` 标记。状态与输出同流，结算永远不会与仍开着的输出通道竞态。

| 配置 | 默认值 | 含义 |
|---|---|---|
| `flushMs` | `100` | 新输出到达后、观察读取前的合并窗口。 |
| `maxFrameBytes` | `65536` | 每个观察输出帧的软字节预算。 |

客户端半区（`./client`）安装 `ctx.activityFeed`：`ClientActivityModel` 镜像 roster（last-wins 分桶、按代整体替换）并为每个被观察 activity 累积有界渲染尾巴；`ClientActivityFeed.observe(id)` 打开按引用计数共享的观察流，跨 carrier 代次从模型游标续传。

## 模型体验

无：activity 传输是浏览器与宿主的观察状态，不注册任何 prompt、工具或会话事件。

#### KV Cache 影响

无；本包从不组装或改动 provider 请求。

## 已知限制与暂缓事项

- **注册表存在性在构造时采样**——控制器之后才挂载的注册表在控制器重载前不会被观察。
- **roster 不携带水位**——观察流自带锚点；roster 行与观察 offset 的对齐是客户端策略。
