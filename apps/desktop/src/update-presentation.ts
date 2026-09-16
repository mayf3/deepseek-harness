/** Semantic content for the Web-localized optional Desktop status indicator. */
import type { DesktopUpdateFailureKind, DesktopUpdatePresentation, DesktopUpdateState } from './ipc.ts'
import type { DesktopMessages } from './locale.ts'

const NETWORK_FAILURE = /\b(?:ERR_CONNECTION_CLOSED|ERR_CONNECTION_RESET|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ETIMEDOUT)\b/u

/**
 * Classify one updater failure for both native and Web-localized summaries.
 * @param state Update failure and its operation.
 * @param messages Selected shell locale, used to recognize shell-owned preparation failures.
 * @returns Stable presentation kind without raw diagnostics.
 */
function desktopUpdateFailureKind(state: DesktopUpdateState, messages: DesktopMessages): DesktopUpdateFailureKind {
  if (state.failedOperation === 'install') {
    if (state.message === messages.updateStopFailed) return 'stop-failed'
    if (state.message === messages.updateTasksChanged) return 'tasks-changed'
    if (state.message === messages.updateTasksUnavailable) return 'tasks-unavailable'
  }
  const operation = state.failedOperation ?? 'install'
  return NETWORK_FAILURE.test(state.message ?? '') ? `${operation}-network` : operation
}

/**
 * Select user-facing error copy independently of raw updater diagnostics.
 * @param state Update failure and its operation.
 * @param messages Selected shell locale.
 * @returns Localized summary suitable for both a dialog and a tooltip.
 */
export function desktopUpdateErrorSummary(state: DesktopUpdateState, messages: DesktopMessages): string {
  const kind = desktopUpdateFailureKind(state, messages)
  const summaries: Readonly<Record<DesktopUpdateFailureKind, string>> = {
    check: messages.updateCheckFailed,
    'check-network': `${messages.updateCheckFailed} ${messages.updateNetworkFailed}`,
    download: messages.updateDownloadFailed,
    'download-network': `${messages.updateDownloadFailed} ${messages.updateNetworkFailed}`,
    install: messages.updateInstallFailed,
    'install-network': `${messages.updateInstallFailed} ${messages.updateNetworkFailed}`,
    'stop-failed': messages.updateStopFailed,
    'tasks-changed': messages.updateTasksChanged,
    'tasks-unavailable': messages.updateTasksUnavailable,
  }
  return summaries[kind]
}

/**
 * @param state - Main-process updater state.
 * @param messages - Electron's selected locale, used only to classify shell-owned failures.
 * @returns Semantic status without localized copy, diagnostics, or installation controls.
 */
export function presentDesktopUpdate(state: DesktopUpdateState, messages: DesktopMessages): DesktopUpdatePresentation {
  return {
    phase: state.phase,
    ...(state.version === undefined ? {} : { version: state.version }),
    ...(state.percent === undefined ? {} : { percent: Math.floor(state.percent) }),
    ...(state.phase === 'error' ? { failure: desktopUpdateFailureKind(state, messages) } : {}),
  }
}
