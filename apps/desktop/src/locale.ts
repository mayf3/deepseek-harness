/** Typed English and Chinese copy owned by the Electron shell. */

export const en = {
  application: 'Application',
  startupFailed: 'DeepSeek Harness is unavailable',
  fatalSummary: 'The application could not start or stopped unexpectedly.',
  diagnosticTruncated: '… Error details shortened. The full diagnostic was written to the Electron console.',
  startupReinstallAdvice: 'If application files are missing or damaged, close the application and reinstall it. Your tasks are stored separately.',
  exitApplication: 'Exit',
  restartApplication: 'Restart',
  recoveryOperationFailed: 'The recovery operation failed',
  disableThirdPartyPlugins: 'Disable third-party plugins, back up profile patch, and restart',
  checkUpdatesMenu: 'Check for Updates…',
  updateCheckFailedTitle: 'Update Check Failed',
  unknownError: 'Unknown error',
  updateCheckTitle: 'Check for Updates',
  updateCurrent: 'You already have the latest version.',
  updateTitle: 'DeepSeek Harness Update',
  updateAvailable: 'An update is available',
  updateDetail: 'DeepSeek Harness {version}\n\nThis release includes its matching dsh version. The application will restart after installation.',
  installAndRestart: 'Install and Restart',
  later: 'Later',
  updateFailedTitle: 'Update Failed',
} as const

/** Every Desktop locale supplies the complete English key set. */
export type DesktopMessages = { readonly [Key in keyof typeof en]: string }

export const zh = {
  application: '应用',
  startupFailed: 'DeepSeek Harness 无法使用',
  fatalSummary: '应用无法启动或已意外停止。',
  diagnosticTruncated: '… 错误详情已截短，完整诊断已写入 Electron 控制台。',
  startupReinstallAdvice: '如果应用文件缺失或损坏，请关闭应用并重新安装。任务数据存储在独立位置。',
  exitApplication: '退出',
  restartApplication: '重启',
  recoveryOperationFailed: '恢复操作失败',
  disableThirdPartyPlugins: '禁用第三方插件、备份 profile patch 并重启',
  checkUpdatesMenu: '检查更新…',
  updateCheckFailedTitle: '更新检查失败',
  unknownError: '未知错误',
  updateCheckTitle: '检查更新',
  updateCurrent: '当前已是最新版本。',
  updateTitle: 'DeepSeek Harness 更新',
  updateAvailable: '发现可用更新',
  updateDetail: 'DeepSeek Harness {version}\n\n新版本绑定匹配的 dsh，安装后将重新启动。',
  installAndRestart: '安装并重启',
  later: '稍后',
  updateFailedTitle: '更新失败',
} as const satisfies DesktopMessages

/** Resolve Electron's locale to one shipped Desktop dictionary. */
export function resolveDesktopLocale(locale: string): DesktopMessages {
  return locale.toLowerCase().startsWith('zh')
    ? zh
    : en
}

/** Replace named placeholders in one locale-owned message. */
export function formatDesktopMessage(
  message: string,
  values: Readonly<Record<string, string>>,
): string {
  return message.replaceAll(/\{([^{}]+)\}/gu, (placeholder, key: string) => values[key] ?? placeholder)
}
