# Agent Note：显示已保存公式结果的浏览器 Excel 预览

Status: implemented

[English](2026-09-16-browser-excel-preview.md) | 中文

## 问题

PDF 转换会丢失工作表导航以及公式与已保存值之间的关系。浏览器能够读取工作簿时，表格预览也没有必要依赖 Host Office 引擎。

## 决策

[文档预览](../../../../packages/client/ui-sidebar-documentpreview/README.zh.md#excel-preview)使用 FortuneSheet 与包内 ExcelJS 适配层打开 XLSX。适配层接收字节和限制并返回工作表数据，不包含 React 状态设置器、计时器或组件引用。ExcelJS 负责 OOXML 解析，适配层负责显示映射。现有完整文件读取器保留 Session 授权、文件版本、重新载入和临时字节。

预览为只读，同时保留公式文本与已保存结果。它不重新计算，因此不受支持的函数不会用错误覆盖有效的已保存结果。没有已保存结果的公式保持为空，并显示工作簿提示。该表格既不是编写工具，也不是完整的 Excel 渲染引擎。

独立可释放的浏览器 Worker 承担解析 CPU 工作。解析前检查压缩字节限制，FortuneSheet 分配矩阵前检查矩形区域合计限制，并通过超时终止停滞的解析。这些限制不代表严格的内存沙箱。样式限定在渲染器区域内，外部超链接仅显示为文本。

固定版本的 FortuneSheet React 依赖带有一个[小补丁](../../../../patches/@fortune-sheet__react@1.0.4.patch)：只读输入框仅在启用公式引用高亮时才提交布局状态更新。无条件更新会在 React 19 下切换工作表时触发最大更新深度错误。浏览器场景通过打包后的 ESM 入口覆盖该故障；CommonJS 入口应用相同修复。升级 FortuneSheet 时需要重新检查此补丁。

## 考虑过的替代方案

**采用 FortuneExcel 面向 React 的转换辅助函数。** 其组件状态设置器和渲染后尺寸调整把文件转换耦合到一种 UI 生命周期。本地适配层无需挂载工作簿即可测试，也不需要第二种中间工作簿模型。

**自行编写 OOXML 解析器或创建新的公共包。** ExcelJS 已经负责容器和文件语义。单个预览使用方不足以支持另一套公共 API、Cordis 服务或通用工作簿抽象；出现第二个独立使用方时再考虑提取。

**保留 PDF 作为 Excel 兜底，或在导入时计算所有公式。** PDF 无法保留表格交互与公式查看，而重新计算可能改变已保存结果。旧版 XLS 显示明确的 XLSX 引导。[Office 引擎决策](../architecture/2026-09-11-node-office-kit.zh.md)仍适用于 Word/PowerPoint 预览与独立转换使用方；转换能力仍支持表格。

## 影响

渲染器用部分 Excel 保真度换取浏览器内导航和可复用的转换代码。包 README 负责说明支持的格式、资源默认值和不支持的功能。真实 XLSX fixture 覆盖转换，Worker 测试覆盖取消和清理，发布 profile 的浏览器场景在禁用 Office 转换后打开工作簿，并在只读设置下复制已保存的 XLOOKUP 结果。
