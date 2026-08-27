---
description: "network 组的包地图：适用于 Harness 发出的每一个请求的进程级出站传输策略。"
kind: "package-group"
---

# net/ — 出站网络传输

[English](README.md) | 中文

## 概述

`net/` 组负责传输层面的决策——它们适用于 Harness 发出的每一个出站请求，与由哪个能力发起无关。目前这样的决策只有一个：请求是否经由 HTTP 代理；对应的包也只有一个。该组之所以存在，是因为这类决策不属于任何单一能力：LLM（大语言模型）适配器、web 搜索后端、MCP 传输与遥测导出器都在彼此无感的情况下继承它，而把它放进其中任何一组，都会让另外三组产生反向依赖。这些包不是能力接缝：传输策略每个进程只有一种实现、一个答案，没有可替换的对象。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

| 包 | 角色 | ctx key |
|---|---|---|
| [`http-proxy/`](http-proxy/README.zh.md) | 解析一份出站代理策略，并将其装为进程的全局 dispatcher | 无——由启动器安装 |

-----

<a id="related-documentation"></a>
## 相关文档

- [网络代理指南](../../docs/user/guide/network-proxy.zh.md)——面向用户的页面：需要导出什么，以及为什么浏览器走代理而终端不走。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>面向维护者的工作上下文——点击展开</summary>

无。

</details>
