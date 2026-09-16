/** Isolated Platform documents owned by the desktop account lifetime. */
import { randomUUID } from 'node:crypto'
import { WebContentsView, session, shell, type BrowserWindow, type IpcMainEvent } from 'electron'
import type { PlatformSession } from '@deepseek-ai/dsh-deepseek-account'

export { PLATFORM_IPC } from './platform-ipc.ts'

/** Bounds in desktop content coordinates, supplied by the owned application renderer. */
export interface PlatformBounds { x: number; y: number; width: number; height: number }

/**
 * Decode the renderer rectangle before allocating a native view.
 * @param value - IPC payload.
 * @returns finite, nonnegative integer coordinates.
 */
export function platformBounds(value: unknown): PlatformBounds {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid Platform bounds')
  const row = value as Record<string, unknown>
  const result: Record<string, number> = {}
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    const n = row[key]
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 100_000) throw new Error('Invalid Platform bounds')
    result[key] = Math.round(n)
  }
  return result as unknown as PlatformBounds
}

/** Native view and its credential snapshot are discarded together. */
export class DesktopPlatformView {
  private account: PlatformSession | null = null
  private view: WebContentsView | undefined
  private owner: BrowserWindow | undefined
  private generation = 0

  /** @param preload - bundled sandboxed Platform preload path. */
  constructor(private readonly preload: string) {}

  /** @param next - private Host credential snapshot; replacement invalidates the current document. */
  setSession(next: PlatformSession | null): void {
    if (next?.token === this.account?.token && next?.origin === this.account?.origin) return
    this.close()
    this.account = next
  }

  /**
   * Create an in-memory browser session after account preparation has completed.
   * @param owner - application window containing the view.
   * @param page - explicit supported Platform page.
   * @param bounds - owned renderer rectangle.
   * @returns when the document finishes loading.
   */
  async open(owner: BrowserWindow, page: 'usage' | 'top-up', bounds: PlatformBounds): Promise<void> {
    this.close()
    const account = this.account
    if (account === null) throw new Error('Platform account unavailable')
    const generation = this.generation
    const browserSession = session.fromPartition(`dsh-platform-${randomUUID()}`)
    browserSession.setPermissionRequestHandler((_contents, _permission, callback) => { callback(false) })
    browserSession.setPermissionCheckHandler(() => false)
    const view = new WebContentsView({ webPreferences: {
      session: browserSession, preload: this.preload, sandbox: true, contextIsolation: true,
      additionalArguments: [`--dsh-platform-origin=${account.origin}`],
      nodeIntegration: false, webSecurity: true,
    } })
    this.view = view
    this.owner = owner
    // External payment and documentation pages open without the embedded session or token.
    view.webContents.setWindowOpenHandler(({ url }) => {
      const destination = new URL(url)
      if (destination.protocol === 'https:' && !destination.username && !destination.password) {
        void shell.openExternal(url).catch(() => {
          // An OS browser-launch failure leaves the embedded page available for retry.
        })
      }
      return { action: 'deny' }
    })
    const allowNavigation = (url: string): boolean => {
      try {
        const parsed = new URL(url)
        return parsed.origin === account.origin && !parsed.username && !parsed.password
      } catch { return false }
    }
    view.webContents.on('will-navigate', (event, url) => { if (!allowNavigation(url)) event.preventDefault() })
    view.webContents.on('will-redirect', (event, url) => { if (!allowNavigation(url)) event.preventDefault() })
    view.webContents.on('will-attach-webview', (event) => { event.preventDefault() })
    view.webContents.on('preload-error', () => { if (this.view === view) this.close() })
    view.webContents.on('render-process-gone', () => { if (this.view === view) this.close() })
    owner.contentView.addChildView(view)
    view.setBounds(bounds)
    try {
      await view.webContents.loadURL(new URL(page === 'usage' ? '/usage' : '/top_up', account.origin).href)
    } catch (error) {
      if (generation === this.generation) this.close()
      throw error
    }
  }

  /** @param bounds - current application viewport rectangle. */
  setBounds(bounds: PlatformBounds): void { this.view?.setBounds(bounds) }

  /**
   * Return prepared credentials only to the current Platform main frame.
   * @param event - Electron-provided sender identity.
   * @returns credentials copied once into the isolated preload.
   */
  bootstrap(event: IpcMainEvent): PlatformSession {
    const view = this.view
    const account = this.account
    if (view === undefined || account === null || event.sender !== view.webContents
      || event.senderFrame !== view.webContents.mainFrame || new URL(event.senderFrame.url).origin !== account.origin) {
      throw new Error('Rejected Platform bootstrap')
    }
    return { ...account }
  }

  /** Destroy the document before releasing its temporary browser storage. */
  close(): void {
    this.generation++
    const view = this.view
    this.view = undefined
    if (view === undefined) return
    if (this.owner !== undefined && !this.owner.isDestroyed()) this.owner.contentView.removeChildView(view)
    this.owner = undefined
    const browserSession = view.webContents.session
    if (!view.webContents.isDestroyed()) view.webContents.close()
    void browserSession.clearStorageData().catch(() => {
      // The non-persistent partition is unreachable after its only view is closed.
    })
  }
}
