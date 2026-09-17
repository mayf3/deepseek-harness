/** Locale-owned Browser tab copy. */
export const zh = {
  'type.label': '浏览器',
  'guide.title': '浏览器',
  'guide.description': '浏览 HTTPS 网页或 loopback 服务',
  'address.placeholder': '输入 HTTPS 或本地 HTTP 地址',
  'address.changed': 'URL 已变化',
  back: '后退',
  forward: '前进',
  reload: '刷新',
  go: '前往',
  external: '在系统浏览器中打开',
  'sandbox.disable': '关闭沙箱限制并允许 loopback',
  'sandbox.enable': '恢复沙箱限制并禁止 loopback',
  'sandbox.warning': '沙箱限制已关闭；页面若到达 DSH 同源地址，可以访问该 origin 的网页数据。',
  start: '输入 HTTPS 地址开始浏览',
  loading: '正在打开…',
  'error.empty': '请输入地址。',
  'error.invalid': '这个地址无效或过长。',
  'error.protocol': '只支持 HTTPS 和 loopback HTTP 地址；本地文件请使用文档预览。',
  'error.credentials': '地址不能包含用户名或密码。',
  'error.application-origin': '不能在嵌入浏览器中打开 DSH 应用自身。',
  'error.loopback': '关闭沙箱限制后才能打开 loopback 地址。',
  'web.unknown': '页面已在 iframe 内跳转；Web 模式无法读取当前 URL。',
} satisfies Record<string, string>

/** Browser dictionary key union. */
export type SidebarBrowserKey = keyof typeof zh

/** English dictionary with the same keys. */
export const en = {
  'type.label': 'Browser',
  'guide.title': 'Browser',
  'guide.description': 'Browse HTTPS pages or loopback services',
  'address.placeholder': 'Enter an HTTPS or local HTTP address',
  'address.changed': 'URL changed',
  back: 'Back',
  forward: 'Forward',
  reload: 'Reload',
  go: 'Go',
  external: 'Open in system browser',
  'sandbox.disable': 'Disable sandbox and allow loopback',
  'sandbox.enable': 'Restore sandbox and block loopback',
  'sandbox.warning': 'Sandbox restrictions are disabled; a page that reaches the DSH origin can access its Web data.',
  start: 'Enter an HTTPS address to start browsing',
  loading: 'Opening…',
  'error.empty': 'Enter an address.',
  'error.invalid': 'That address is invalid or too long.',
  'error.protocol': 'Only HTTPS and loopback HTTP addresses are supported; use Document Preview for local files.',
  'error.credentials': 'Addresses cannot contain a username or password.',
  'error.application-origin': 'The embedded browser cannot open the DSH application itself.',
  'error.loopback': 'Disable sandbox restrictions before opening a loopback address.',
  'web.unknown': 'The page navigated inside the iframe; Web mode cannot read its current URL.',
} satisfies Record<SidebarBrowserKey, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Sidebar Browser labels, navigation controls, and failures. */
    sidebarBrowser: SidebarBrowserKey
  }
}
