/** Locale-owned Excel preview controls and parser feedback. */
export const zh = {
  title: '表格', language: 'zh', loading: '正在打开表格…',
  invalid: '无法打开此表格。请检查文件格式、内容或密码保护。',
  tooLarge: '此表格超过预览大小限制。', timeout: '打开表格超时。请缩小文件后重试。',
  encoding: '无法识别此文本文件的编码。请另存为 UTF-8 或带 BOM 的 UTF-16 后重试。',
  summary: '只读预览 · 显示已保存的公式结果',
  textSummary: '只读预览 · 按原始文本显示单元格',
  xlsLimitations: '旧版 XLS 显示数据、数字格式和基本布局；字体、边框、冻结窗格、图表和图片等暂不显示。',
  limitations: '图表、图片、数据透视表和条件格式暂不显示。',
  missingResults: '部分公式没有已保存的结果。请在 Excel 中重新计算并保存。',
  retry: '重试',
} satisfies Record<string, string>

/** Excel preview dictionary keys. */
export type ExcelPreviewKey = keyof typeof zh

/** English Excel preview copy. */
export const en = {
  title: 'Spreadsheet', language: 'en', loading: 'Opening spreadsheet…',
  invalid: 'This spreadsheet could not be opened. Check its format, contents, or password protection.',
  tooLarge: 'This workbook exceeds the preview size limit.', timeout: 'Opening this workbook timed out. Try a smaller file.',
  encoding: 'This text encoding could not be read. Save the file as UTF-8 or UTF-16 with a BOM and retry.',
  summary: 'Read-only preview · Saved formula results',
  textSummary: 'Read-only preview · Literal cell text',
  xlsLimitations: 'Legacy XLS shows data, number formats, and basic layout; fonts, borders, frozen panes, charts, and images are not displayed.',
  limitations: 'Charts, images, pivot tables, and conditional formatting are not displayed yet.',
  missingResults: 'Some formulas have no saved result. Recalculate and save the file in Excel.',
  retry: 'Retry',
} satisfies Record<ExcelPreviewKey, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Excel preview status and third-party locale selection. */
    sidebarExcel: ExcelPreviewKey
  }
}
