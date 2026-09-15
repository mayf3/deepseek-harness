# Agent Note: Composer 粘贴插入换行节点

Status: implemented

[English](2026-09-15-composer-paste-line-breaks.md) | 中文

## 问题

粘贴的多行草稿与逐行打字的草稿文本相同，但文档不同。Composer 的粘贴路径经 `RangeSelection.insertText` 插入剪贴板文本，会把每个换行都留在同一个文本节点内；而打字和编辑器自身的程序化写入会为每行产生一个换行节点。

在单个文本节点内，浏览器把折叠光标的几何信息报告为整个块的几何信息。当粘贴草稿滚动到末尾时，删掉末尾那行会让 Lexical 自己的折叠光标 reveal（`scrollIntoViewIfNeeded`，由 `$updateDOMSelection` 到达）读到一个位于块顶部的零高度矩形，并把该偏移写进 composer 的滚动容器。于是这个带高度上限的框显示出草稿开头、光标落在屏幕外，而草稿本身仍然溢出。同一份文档还让 Home 键与纵向光标移动拿到块级边界，而不是行级边界。

## 决策

[`DraftEditorRuntime.paste()`](../../../../packages/client/ui-conversation/src/client/input/editor/runtime.ts) 改经 `RangeSelection.insertRawText` 插入，这也是 Lexical 自身粘贴处理器所用的路径；它的 raw-text 生成器把输入拆成文本节点与换行节点。因此粘贴草稿与打字草稿携带相同的文档，两者投影出相同的草稿文本。

## 考虑过的替代方案

**保留 `insertText`，在 composer 视图里修正 reveal。** 失败手势中 composer 自己的 `revealDraftSelection` 从未运行：那次写入来自 Lexical 的选区对账，折叠选区的光标 reveal 归它所有。给该函数加守卫无法触及它，而屏蔽 Lexical 的 reveal 又会去掉普通打字所依赖的光标跟随。

**在粘贴文本内重写换行。** 插入前规范化剪贴板文本不会改变文档——缺陷在于插入产生的节点结构，而不在于它接收的字符。

## 影响

粘贴的换行成为换行节点，而不再是文本节点内的字符。剪贴板投影、并因此提交的 prompt、草稿镜像和触发词跨度都不变：`$composerLayout` 把换行节点与段落间隙同样投影为一个 `\n`。制表符经同一条 raw-text 路径落到 `TabNode`。composer 不再依赖浏览器为「整篇存于一个文本节点」的草稿报告逐行几何信息。

## 测试

[Composer 滚动场景](../../../../apps/web/tests/composer-draft-scroll.e2e.ts)在真实浏览器里固定该行为：尾部为空行的粘贴草稿滚动到末尾后，在草稿末尾按退格、以及选中末尾若干行后删除，都保持 `scrollTop === scrollMax`。把 `paste()` 退回 `insertText` 会让该用例在草稿仍然溢出时于 `scrollTop === scrollMax` 上失败；该场景中的打字草稿用例与已提交的几何 golden 在两种插入路径下都通过。
