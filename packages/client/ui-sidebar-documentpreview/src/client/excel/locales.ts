/** Locale-owned Excel preview controls and parser feedback. */
export const zh = {
  title: 'Excel', language: 'zh', loading: '正在打开表格…',
  invalid: '无法打开此 Excel 文件。文件可能已损坏或受密码保护。',
  tooLarge: '此表格超过预览大小限制。', timeout: '打开表格超时。请缩小文件后重试。',
  legacy: '请将此旧版 Excel 文件另存为 .xlsx 后预览。',
  summary: '只读预览 · 显示已保存的公式结果',
  limitations: '图表、图片、数据透视表和条件格式暂不显示。',
  missingResults: '部分公式没有已保存的结果。请在 Excel 中重新计算并保存。',
  retry: '重试',
} satisfies Record<string, string>

/** Excel preview dictionary keys. */
export type ExcelPreviewKey = keyof typeof zh

/** English Excel preview copy. */
export const en = {
  title: 'Excel', language: 'en', loading: 'Opening spreadsheet…',
  invalid: 'This Excel file could not be opened. It may be damaged or password protected.',
  tooLarge: 'This workbook exceeds the preview size limit.', timeout: 'Opening this workbook timed out. Try a smaller file.',
  legacy: 'Save this legacy Excel file as .xlsx to preview it.',
  summary: 'Read-only preview · Saved formula results',
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
