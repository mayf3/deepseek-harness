# @deepseek-ai/dsh-client-ui-chat

[English](README.md) | 中文

Conversation 组装的浏览器 Chat target。本包注册 Chat event definition 与 snapshot 构造、提供 `useChat`、渲染 transcript node 和详情，并拥有 Chat 专属 store、action、本地化与滚动位置恢复；历史图片 URL 通过 Conversation 持有的按会话缓存（`ctx.uiConversation.imageUrl`）解析。

## 模型体验

无，因为本包在浏览器中渲染已记录的对话状态，不注册任何面向模型的内容。

#### KV Cache 影响

无；Chat 呈现不会组装或修改提供方请求。

## 已知限制与暂缓事项

- **视图只反映已加载的 Session 窗口**——只有 Session Controller 加载前一页 event 后，更早的 transcript node 才会出现。轮次导航同样只表示已加载的 Turn；加载更早一页时，已有 Turn 刻度保持身份不变，完整的已加载集合在紧凑轨道中重新排布，不显示未加载历史占位。刻度默认相隔 10px，仅在已加载集合超过可用高度时压缩间距。
