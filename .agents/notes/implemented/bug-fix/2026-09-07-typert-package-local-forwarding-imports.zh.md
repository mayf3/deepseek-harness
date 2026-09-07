# Agent Note: Typert 引用追踪包内转发模块

Status: implemented

[English](2026-09-07-typert-package-local-forwarding-imports.md) | 中文

## Problem

`WorkspaceAnalyzer` 先把每个类型引用解析到原始声明再分类，然后只读引用所在文件自己的 `import` 语句来判断该引用是否经由公开导出跨包。一个包若在自己的某个模块里重新导出另一个包的类型，并在别处用相对路径导入该模块，就会报 `crosses a package without an explicit package import`，尽管包导入只隔一跳。这个失败在任何批次大小和包顺序下都会稳定出现；它出现在哪次分析里，取决于哪次分析把引用方的包选为根，因此 [issue 3525](https://github.com/deepseek-harness/deepseek-harness/issues/3525) 观察到的现象像是与批次相关。

## Decision

[`targetForReference`](../../../../packages/typert/generator/src/analyzer.ts) 用程序的模块解析来解析相对说明符，且只在解析到的文件仍位于引用方包内时继续追踪。在每个转发模块里，它找出承载所请求名字的那条 `export` 边：带说明符的具名重新导出、导出同一符号的星号重新导出，或由该模块自身 `import` 支撑的 `export { local }`。追踪在遇到第一个包说明符时停止，并把该包身份和导出名交给现有的 `packageExportName` 检查，因此被转发的类型仍必须在转发模块所写的包子路径上公开。引用模型不变：同 face 的所有者仍是 `declaration`，另一 face 仍是 `cross-face`。

当相对说明符解析到引用方包之外、转发模块重新导出命名空间，或转发链重复访问同一文件时，追踪得不到包导入，引用照旧失败。

## Alternatives considered

**把别名链终点在另一个包的相对导入视为隐式公开。** 已拒绝：这会接受 `../../other/src/file.ts`，也会接受自身用相对路径抵达另一个包的转发模块，从而取消公开导出检查，而生成的 Remote 声明依赖该检查来命名可导入的子路径。

**把转发模块记为引用目标。** 已拒绝：发射器和跨 face 链接需要原始声明的包和公开子路径，包内模块没有自己的公开身份。

**让分批分析与全工作区分析选择相同的根。** 作为修复方案已拒绝：根的选择不改变对一个引用的判定，只决定该引用是否被访问，对齐调用方只会掩盖错误分类，不能消除它。

## Consequences

包可以为外部类型保留一个转发模块并用相对路径导入它，与自身模块的组织方式一致。每个跨包相对引用每跳付出一次模块解析，由共享编译器宿主缓存。[`type-model.spec.ts`](../../../../packages/typert/generator/tests/type-model.spec.ts) 固定了具名、改名多跳、先导入再导出、星号和命名空间导入这几种转发，被转发的私有导出，用相对路径跨包的转发模块，跨 face 转发，以及转发 fixture 在不同批次大小和包顺序下全量分析与分批分析相等。
