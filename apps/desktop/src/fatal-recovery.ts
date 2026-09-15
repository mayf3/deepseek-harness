/** Native recovery for the first fatal failure in one Desktop process. */

import type { MessageBoxOptions, MessageBoxReturnValue } from 'electron'
import type { DesktopMessages } from './locale.ts'
import { desktopErrorState } from './startup-error.ts'

interface RecoveryOperations {
  messages(): DesktopMessages
  show(options: MessageBoxOptions): Promise<MessageBoxReturnValue>
  stop(): Promise<void>
  disablePlugins(): Promise<void>
  exit(): void
  restart(): void
}

/** Deduplicates fatal reports while keeping explicit recovery-operation failures actionable. */
export class DesktopFatalRecovery {
  private reported = false

  /** @param operations - Native presentation and application-owned shutdown operations. */
  constructor(private readonly operations: RecoveryOperations) {}

  /**
   * Show the first fatal error; later reports cannot replace it or open another dialog.
   * @param error - Fatal failure, including nested diagnostic causes.
   * @returns Completion of the user's recovery action; duplicate reports resolve immediately.
   */
  async report(error: unknown): Promise<void> {
    if (this.reported) return
    this.reported = true
    const messages = this.operations.messages()
    let detail = desktopErrorState(error).message
    let message = messages.startupFailed
    for (;;) {
      const { response } = await this.operations.show({
        type: 'error',
        title: messages.startupFailed,
        message,
        detail: `${detail}\n\n${messages.startupReinstallAdvice}`,
        buttons: [messages.exitApplication, messages.restartApplication, messages.disableThirdPartyPlugins],
        defaultId: 1,
        cancelId: 0,
        noLink: true,
      })
      if (response === 0) {
        try { await this.operations.stop() } catch (failure) { console.error(failure) }
        this.operations.exit()
        return
      }
      try {
        await this.operations.stop()
        if (response === 2) await this.operations.disablePlugins()
        this.operations.restart()
        return
      } catch (failure) {
        console.error(failure)
        message = messages.recoveryOperationFailed
        detail = desktopErrorState(failure).message
      }
    }
  }
}
