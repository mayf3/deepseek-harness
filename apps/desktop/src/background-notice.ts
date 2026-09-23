/** One-time Windows notice that closing the window left the application running in the tray. */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { Notification } from 'electron'
import type { DesktopLocale } from './locale.ts'

/** Marker location and the actions the notice can trigger. */
export interface DesktopBackgroundNoticeOptions {
  /**
   * Marker written the first time the notice is shown. Lives under Electron's userData, which the
   * uninstaller removes and in-place updates keep, so each installation sees the notice once.
   */
  readonly markerPath: string
  readonly locale: () => DesktopLocale
  /** Show and focus the primary window when the notice is clicked. */
  readonly open: () => void
}

/** Shows once per installation, and at most once per process even when the marker cannot be written. */
export class DesktopBackgroundNotice {
  private shown = false
  private notification: Notification | undefined

  /** @param options - Marker path, locale reader, and the click action. */
  constructor(private readonly options: DesktopBackgroundNoticeOptions) {}

  /**
   * Show the notice after the first hide of this installation. System notification permissions or a
   * focus mode can suppress it; the window stays hidden and the tray stays available either way.
   */
  show(): void {
    if (this.shown) return
    this.shown = true
    if (existsSync(this.options.markerPath)) return
    try {
      mkdirSync(dirname(this.options.markerPath), { recursive: true })
      writeFileSync(this.options.markerPath, '')
    } catch (error) { console.warn('desktop tray: could not record the background notice', error) }
    try {
      if (!Notification.isSupported()) return
      const { messages } = this.options.locale()
      const notification = new Notification({ title: messages.backgroundNoticeTitle, body: messages.backgroundNoticeBody, silent: true })
      this.notification = notification
      notification.on('failed', () => {
        if (this.notification === notification) this.notification = undefined
        notification.removeAllListeners()
      })
      notification.once('click', () => {
        if (this.notification !== notification) return
        this.notification = undefined
        notification.removeAllListeners()
        this.options.open()
      })
      notification.show()
    } catch (error) { console.warn('desktop tray: background notice unavailable', error) }
  }
}
