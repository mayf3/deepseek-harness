/** Copy owned by the PDF renderer. */
export const zh = {
  title: 'PDF',
  toolbar: 'PDF 阅读工具',
  previous: '上一页',
  next: '下一页',
  page: '页码',
  pageCount: '共 {total} 页',
  pageImage: 'PDF 第 {page} 页',
  zoomIn: '放大',
  zoomOut: '缩小',
  resetZoom: '重置缩放',
  zoom: '{percent}%',
  loading: '正在打开 PDF…',
  rendering: '正在绘制页面…',
  failed: '无法显示 PDF：{message}',
  password: '此 PDF 需要密码，暂不支持预览。',
  workerFailed: 'PDF 渲染进程无法继续，请重试。',
  unsupported: 'PDF 预览需要完整文件内容。',
  retry: '重试',
} satisfies Record<string, string>

/** PDF translation keys shared by both dictionaries. */
export type PdfLocaleKey = keyof typeof zh

/** English PDF-renderer dictionary. */
export const en = {
  title: 'PDF',
  toolbar: 'PDF reading tools',
  previous: 'Previous page',
  next: 'Next page',
  page: 'Page',
  pageCount: 'of {total}',
  pageImage: 'PDF page {page}',
  zoomIn: 'Zoom in',
  zoomOut: 'Zoom out',
  resetZoom: 'Reset zoom',
  zoom: '{percent}%',
  loading: 'Opening PDF…',
  rendering: 'Rendering page…',
  failed: 'Cannot display PDF: {message}',
  password: 'This PDF requires a password; password-protected previews are not supported.',
  workerFailed: 'The PDF rendering process could not continue. Please retry.',
  unsupported: 'PDF preview requires the complete file contents.',
  retry: 'Retry',
} satisfies Record<PdfLocaleKey, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** PDF navigation, loading, and failure messages. */
    sidebarPdf: PdfLocaleKey
  }
}
