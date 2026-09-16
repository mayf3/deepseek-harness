# Agent Note: 已知站点链接标记

Status: implemented

[English](2026-09-16-known-site-link-marks.md) | 中文

## Problem

转写内容中的每个锚点都以同一个地球图形开头，因此满是 GitHub、npm 与文档链接的对话在读者解析标签之前，无法从图形看出链接去向。[可点击链接词汇](2026-09-04-web-clickable-link-styles.zh.md) 把该前置位置留给一个分类图形，并把按站点区分的标记留作 `url` 类别日后可能的扩展。

## Decision

`LinkIcon` 接受可选的 `href`。对于 `url` 类别，目的地主机属于已知站点时改画该站点自己的标记；其余 `url` 目的地仍使用地球，文件类别忽略 `href`，因为它们的目的地是路径而不是站点。

ui-primitives 的 `SiteGlyph.tsx` 持有该映射：十八个主机后缀解析为十四个标记——GitHub（`github.com`、`github.io`、`raw.githubusercontent.com`）、GitLab、npm、PyPI、Stack Overflow、MDN、Wikipedia、Hacker News、YouTube（`youtube.com`、`youtu.be`）、X（`x.com`、`twitter.com`）、Bilibili、知乎、掘金与 CSDN。去掉 `www.` 后，主机等于某后缀或为其子域即匹配，因此 `gist.github.com` 与 `en.wikipedia.org` 无需单独登记。只有绝对 `http:` 与 `https:` 目的地能够匹配，其余一律回退到地球。

标记取自 [Simple Icons](https://simpleicons.org) 图标集的单路径形式（CC0-1.0），沿用该图标集的 24×24 viewBox，并与其他链接图形一样以 `currentColor` 填充，因此会跟随两种主题、hover 与 focus 下的链接颜色。所有标记均为 `aria-hidden`，锚点自身文本仍是可访问名称。

两处消费者传入自己的目的地：markdown 渲染器的 `renderSafeLink`（覆盖作者书写的锚点、引用式链接与提升为链接的行内代码）以及 web 卡片的来源与抓取链接。两者本已持有经安全校验的目的地。

## Alternatives considered

- **抓取各站点的 favicon**，无论取自站点本身还是 favicon 服务。这能覆盖任意站点，但渲染一份转写内容会向每个被链接的主机发起网络请求，泄露阅读行为并把文本渲染变成网络操作；它在离线与严格 `img-src` 策略下同样失败，且需要新增外部依赖。拒绝：固定的本地词汇表让渲染保持确定与私密，地球仍是诚实的回退。
- **以站点品牌色填充标记。** 拒绝：链接图形只使用 `currentColor`，以跟随链接 alias、暗色模式与 hover；固定填充会成为首个例外，并与链接自身的 hover 颜色冲突。
- **把站点值加进 `LinkIconKind`。** 拒绝：kind 是消费者陈述的分类，而站点由目的地推导；把两者折进同一联合类型会迫使每个消费者写出自己并不知晓的站点。
- **为每个未映射主机生成首字母方块。** 以噪音为由拒绝：自动生成的字母胶囊宣称了一种站点身份却没有承载它，14px 也没有留下可读字母的空间。

## Consequences

- 新增站点就是在 `SiteGlyph.tsx` 中加一条路径与一条主机记录；`link-icon` spec 为每个已映射站点固定一个主机并要求它们的标记互不相同，因此路径丢失或重复会让测试失败。
- 未收录主机、非 http scheme、无法解析的目的地与文件类别都保留原有的地球或分类图形；转写内容中的 `mailto` 链接仍显示地球。
- 该词汇表刻意有限。像 `example.com` 这样的站点不会由此机制获得标记；要识别它们就需要被上述备选方案拒绝的网络抓取。
- 覆盖：LinkIcon spec 覆盖别名、各回退分支与尺寸座位；markdown spec 固定一个已知锚点与一个未知锚点；web 卡片 spec 用同一批标记固定一个来源链接与一个抓取链接。
