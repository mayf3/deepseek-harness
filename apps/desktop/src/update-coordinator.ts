/** One Electron release stream for the version-bound shell and bundled dsh runtime. */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import electronUpdater, { type AppUpdater } from 'electron-updater'
const { autoUpdater } = electronUpdater

/** Result of checking or installing a Desktop release. */
export interface DesktopUpdateState {
  readonly phase: 'idle' | 'available' | 'ready' | 'error'
  readonly version?: string
  readonly message?: string
}

/** Checks, downloads, and installs one complete Desktop release. */
export class DesktopUpdateCoordinator {
  private availableVersion: string | undefined
  private checkOperation: Promise<DesktopUpdateState> | undefined
  private installOperation: Promise<DesktopUpdateState> | undefined

  /**
   * @param beforeRestart - stop application-owned processes before replacement.
   * @param updater - Electron artifact updater; replaceable for tests.
   * @param enabled - whether this packaged process carries updater configuration.
   */
  constructor(
    private readonly beforeRestart: () => Promise<void> = async () => {},
    private readonly updater: AppUpdater = autoUpdater,
    private readonly enabled: () => boolean = () => (
      app.isPackaged && existsSync(join(process.resourcesPath, 'app-update.yml'))
    ),
  ) {
    this.updater.autoDownload = false
    this.updater.autoInstallOnAppQuit = false
  }

  /** Check the configured Desktop release stream and retain an available version. */
  async check(): Promise<DesktopUpdateState> {
    if (this.installOperation !== undefined) return this.installOperation
    if (this.checkOperation !== undefined) return this.checkOperation
    this.checkOperation = this.doCheck().finally(() => { this.checkOperation = undefined })
    return this.checkOperation
  }

  /** Wait for an in-flight check, then download and install its retained release. */
  async install(): Promise<DesktopUpdateState> {
    if (this.installOperation !== undefined) return this.installOperation
    this.installOperation = (async () => {
      await this.checkOperation
      return this.doInstall()
    })().finally(() => { this.installOperation = undefined })
    return this.installOperation
  }

  private async doCheck(): Promise<DesktopUpdateState> {
    try {
      if (!this.enabled()) {
        this.availableVersion = undefined
        return { phase: 'idle' }
      }
      const result = await this.updater.checkForUpdates()
      const version = result?.isUpdateAvailable === true ? result.updateInfo.version : undefined
      this.availableVersion = version
      return version === undefined
        ? { phase: 'idle' }
        : { phase: 'available', version }
    } catch (error) {
      this.availableVersion = undefined
      return {
        phase: 'error',
        message: error instanceof Error ? error.message : String(error),
      }
    }
  }

  private async doInstall(): Promise<DesktopUpdateState> {
    const version = this.availableVersion
    if (version === undefined) {
      throw new Error('desktop update: no verified update is available')
    }
    try {
      await this.updater.downloadUpdate()
      this.availableVersion = undefined
      await this.beforeRestart()
      this.updater.quitAndInstall(false, true)
      return { phase: 'ready', version }
    } catch (error) {
      return {
        phase: 'error',
        version,
        message: error instanceof Error ? error.message : String(error),
      }
    }
  }
}
