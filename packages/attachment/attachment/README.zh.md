# @deepseek-ai/dsh-attachment

[English](README.md) | 中文

持久附件服务边界。`ctx.attachments` 校验并以原子方式提交不可变图片字节，随后返回可序列化的 `ImageAttachmentRef`；消费方绝不会在会话事件中持久保存浏览器路径、对象 URL、提供方 URL 或 base64。

未发送的输入区图片仍是由浏览器持有的临时草稿。`validateImage` 运行相同的准入策略，但不执行持久化；批量写入方会先校验每个成员，避免某个格式错误的成员使较早的成员成为无引用对象。`saveImage` 会在发布任何模型可见的会话事件前提交每张已接受的图片，`readImage` 则根据已记录的元数据校验内容寻址对象。调用方可以取消 `readImage`；实现会在后端读取与校验工作的边界观察取消，并保留取消语义，而不会将其转换为存储失败。

`admitEncodedImages(attachments, images)` 是每个接受浏览器上传的 RPC 端点（会话 prompt 端点与命令执行器）共用的批量准入函数：它按 `imageLimits` 强制执行规范 base64、单条消息张数上限与聚合字节上限，先校验整个批量，再提交每个成员并按调用方顺序返回 `ImageAttachmentRef`；被拒绝的批量不会发布任何持久化对象。base64 上传形式为 `EncodedImageAttachment`，从 `@deepseek-ai/dsh-attachment/types` 导出，供 wire 契约引用。

## 模型体验

该包通过角色无关的核心 `ImageBlock`，以及解析其持久引用的提供方适配器，间接影响模型。

#### KV 缓存影响

添加图片会改变提供方请求，因此会使受影响的请求后缀失效。

## 已知限制与待完成工作

- 第一版仅接受 PNG、JPEG、WebP 和 GIF。
- 保留策略与垃圾回收尚未实现，因为恢复和 fork 后的会话可能共享不可变对象。
- 通用文件、音频、视频和持久的未发送草稿需要单独的生命周期与提供方契约。
