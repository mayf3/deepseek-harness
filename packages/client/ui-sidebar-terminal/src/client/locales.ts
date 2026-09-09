/** Copy owned by the sidebar terminal feature. */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    sidebarTerminal: keyof typeof zh
  }
}

/** Simplified Chinese terminal copy. */
export const zh = {
  recoveryFailed: '恢复终端失败：{message}', retryRecovery: '重试恢复终端',
  title: '终端', new: '新建终端', loading: '正在读取终端环境…', creating: '正在启动…',
  connecting: '正在连接…', disconnected: '连接已断开。', reconnect: '重新连接',
  readonly: '此页面当前只读。', control: '接管输入',
  closed: '终端已关闭。', exited: '进程已退出（{code}）', failed: '终端错误：{message}',
  rename: '终端名称', unavailable: '不可用', retry: '重试',
  cleanupFailed: '终端「{title}」未能结束：{message}',
} satisfies Record<string, string>

/** English terminal copy. */
export const en = {
  recoveryFailed: 'Terminal recovery failed: {message}', retryRecovery: 'Retry terminal recovery',
  title: 'Terminal', new: 'New terminal', loading: 'Reading terminal environment…', creating: 'Starting…',
  connecting: 'Connecting…', disconnected: 'Disconnected.', reconnect: 'Reconnect',
  readonly: 'This view is read-only.', control: 'Take control',
  closed: 'Terminal closed.', exited: 'Process exited ({code})', failed: 'Terminal error: {message}',
  rename: 'Terminal name', unavailable: 'Unavailable', retry: 'Retry',
  cleanupFailed: 'Terminal “{title}” could not be ended: {message}',
} satisfies Record<keyof typeof zh, string>
