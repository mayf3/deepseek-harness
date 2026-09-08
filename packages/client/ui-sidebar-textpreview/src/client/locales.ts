/**
 * `sidebarTextpreview` namespace dictionaries.
 *
 * The failure lines are the point of this file: a preview that cannot show a
 * page has to say which of several different things went wrong, and each one
 * suggests a different next step for the reader.
 */

/** Simplified Chinese dictionary and key-set source of truth. */
export const zh = {
  loading: '正在读取…',
  loadMore: '加载更多',
  changed: '文件已被修改，显示的还是旧内容。',
  reloadNow: '重新载入',
  reload: '重新读取文件',
  wrap: '自动换行',
  openWith: '打开方式',
  'viewer.text': '纯文本',
  resourceUnavailable: '文件资源服务不可用。',
  rendererUnavailable: '预览器 {name} 不可用。',
  'error.notFound': '这个文件不在了。可能已被移动或删除。',
  'error.outsideWorkspace': '这个文件在工作区之外，侧栏不会读取它。',
  'error.tooLarge': '请求读取的内容太大，超过了 {limit} 的上限。',
  'error.notText': '这不是文本文件，没法在这里查看。',
  'error.notRegularFile': '这不是一个普通文件，没有可显示的文本。',
  'error.unavailable': '读取失败：{message}',
  retry: '重试',
} satisfies Record<string, string>

/** Text-preview dictionary key union. */
export type SidebarTextpreviewKey = keyof typeof zh

/** English dictionary, checked against the Chinese key set. */
export const en = {
  loading: 'Reading…',
  loadMore: 'Load more',
  changed: 'The file has changed; this is the older text.',
  reloadNow: 'Reload',
  reload: 'Read the file again',
  wrap: 'Wrap lines',
  openWith: 'Open with',
  'viewer.text': 'Plain text',
  resourceUnavailable: 'The file resource service is unavailable.',
  rendererUnavailable: 'The {name} preview is unavailable.',
  'error.notFound': 'That file is gone. It may have been moved or deleted.',
  'error.outsideWorkspace': 'That file is outside the workspace, so the sidebar will not read it.',
  'error.tooLarge': 'The requested content exceeds the {limit} read limit.',
  'error.notText': 'That is not a text file, so it cannot be shown here.',
  'error.notRegularFile': 'That is not a regular file, so it has no text to show.',
  'error.unavailable': 'Read failed: {message}',
  retry: 'Retry',
} satisfies Record<SidebarTextpreviewKey, string>
