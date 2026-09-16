/** Isolated, process-lifetime Feishu cookies for explicitly configured test policy requests. */
import { randomUUID } from 'node:crypto'
import { BrowserWindow, session } from 'electron'
import type { DesktopLocale } from './locale.ts'

const FEISHU_ORIGINS = ['https://open.feishu.cn', 'https://accounts.feishu.cn',
  'https://passport.feishu.cn', 'https://login.feishu.cn']

/** Navigation completion is not proof of authentication or a valid update policy. */
export type DesktopPolicyLoginResult = 'returned' | 'cancelled' | 'failed'

/** Owns the login window and its nonpersistent Session; no product window shares its cookies or privileges. */
export class DesktopPolicyTestAuth {
  private readonly browserSession = session.fromPartition(`dsh-policy-auth-${randomUUID()}`, { cache: false })
  private window: BrowserWindow | undefined
  private pending: Promise<DesktopPolicyLoginResult> | undefined
  private disposed = false
  private rejectLogin: (() => void) | undefined

  /** Return to an existing login window without starting another authentication flow. */
  focus(): void { this.window?.show(); this.window?.focus() }

  /**
   * @param origin Validated HTTPS policy origin; login always starts at its root with fresh gateway state.
   * @param locale Shell-owned login title.
   * @param parent Current application or mandatory-update window.
   * @param record Fixed, nonsecret login outcomes for diagnostic evidence.
   */
  constructor(private readonly origin: string, private readonly locale: DesktopLocale,
    private readonly parent: () => BrowserWindow | undefined,
    private readonly record: (event: 'opened' | DesktopPolicyLoginResult) => void) {
    this.browserSession.setPermissionRequestHandler((_contents, _permission, callback) => { callback(false) })
    this.browserSession.setPermissionCheckHandler(() => false)
    this.browserSession.setDevicePermissionHandler(() => false)
    this.browserSession.on('will-download', (event) => { event.preventDefault() })
    this.browserSession.webRequest.onBeforeRequest((details, callback) => {
      const document = details.resourceType === 'mainFrame' || details.resourceType === 'subFrame'
      const cancel = document && !this.allowed(details.url)
      callback({ cancel })
      if (cancel) this.rejectLogin?.()
    })
  }

  /**
   * Send only the configured policy request through the login Session; redirects remain forbidden.
   * @param input Policy URL supplied by the main-process coordinator.
   * @param init Request headers, credentials, and cancellation owned by that coordinator.
   * @returns Chromium response without exposing cookies to JavaScript.
   */
  readonly request: typeof fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (this.disposed || url.origin !== this.origin || url.pathname !== '/api/v0/check_client_update'
      || url.username !== '' || url.password !== '') {
      return Promise.reject(new Error('desktop policy: disallowed authenticated request'))
    }
    return this.browserSession.fetch(url.href, { ...init, credentials: 'include', redirect: 'error', cache: 'no-store' })
  }

  /**
   * Open only after a user action; repeated callers focus and join the same login.
   * @returns Navigation, cancellation, or failure; the caller must query policy after returning.
   */
  login(): Promise<DesktopPolicyLoginResult> {
    if (this.disposed) return Promise.resolve('cancelled')
    if (this.pending !== undefined) { this.focus(); return this.pending }
    const result = Promise.withResolvers<DesktopPolicyLoginResult>()
    const parent = this.parent()
    const window = new BrowserWindow({ width: 720, height: 760, ...(parent === undefined ? {} : { parent }),
      title: this.locale.messages.policyLoginTitle, autoHideMenuBar: true,
      webPreferences: { session: this.browserSession, nodeIntegration: false, contextIsolation: true,
        sandbox: true, webSecurity: true, webviewTag: false, devTools: false, spellcheck: false } })
    this.pending = result.promise
    this.window = window
    let settled = false
    const finish = (outcome: DesktopPolicyLoginResult): void => {
      if (settled) return
      settled = true
      this.window = undefined
      this.pending = undefined
      this.rejectLogin = undefined
      if (!window.isDestroyed()) window.destroy()
      result.resolve(outcome)
      this.record(outcome)
    }
    this.rejectLogin = () => { finish('failed') }
    window.setMenu(null)
    window.on('closed', () => { finish('cancelled') })
    window.on('page-title-updated', (event) => { event.preventDefault() })
    const contents = window.webContents
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-navigate', (event, url) => {
      if (!this.allowed(url)) { event.preventDefault(); finish('failed') }
    })
    contents.on('will-redirect', (event, url) => {
      if (!this.allowed(url)) { event.preventDefault(); finish('failed') }
    })
    contents.on('will-attach-webview', (event) => { event.preventDefault() })
    contents.on('login', (event, _details, _authInfo, callback) => { event.preventDefault(); callback() })
    contents.on('did-fail-load', (_event, code, _description, _url, mainFrame) => {
      if (mainFrame && code !== -3) finish('failed')
    })
    contents.on('render-process-gone', () => { finish('failed') })
    contents.on('did-navigate', (_event, value) => {
      const url = new URL(value)
      if (url.origin === this.origin && (url.pathname === '/' || url.pathname === '/feishu_auth_callback')) finish('returned')
    })
    this.record('opened')
    void window.loadURL(`${this.origin}/`).catch(() => { finish('failed') })
    return result.promise
  }

  /** Close the login and erase session data after the policy coordinator has stopped its requests. */
  async dispose(): Promise<void> {
    this.disposed = true
    this.window?.destroy()
    await this.pending
    await this.browserSession.closeAllConnections()
    await this.browserSession.clearStorageData()
    await this.browserSession.clearAuthCache()
  }

  private allowed(value: string): boolean {
    let url: URL
    try { url = new URL(value) } catch { return false }
    return url.protocol === 'https:' && url.username === '' && url.password === ''
      && (url.origin === this.origin || FEISHU_ORIGINS.includes(url.origin))
  }
}
