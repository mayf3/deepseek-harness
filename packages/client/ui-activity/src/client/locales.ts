/** `activity` namespace dictionaries. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'activity'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'count.live.one': '{count} 个活动进行中',
  'count.live.other': '{count} 个活动进行中',
  'count.idle.one': '{count} 个活动',
  'count.idle.other': '{count} 个活动',
  'list.aria': '实时活动',
  'row.expandAria': '展开 {label} 的实时输出',
  'row.collapseAria': '收起 {label} 的实时输出',
  'status.running': '运行中',
  'status.completed': '已完成',
  'status.killed': '已取消',
  'status.failed': '已失败',
  'output.gap': '……较早的输出已丢弃……',
  'output.error': '实时输出流中断：{error}',
  'terminal.signal': '信号 {signal}',
  'terminal.exitCode': '退出码 {code}',
  'terminal.running': '运行中',
  'terminal.failed': '已失败',
  'terminal.done': '已完成',
  'terminal.copy': '复制',
  'terminal.copied': '已复制',
  'terminal.noOutput': '（无输出）',
  'terminal.collapse': '收起',
  'terminal.collapseAria': '收起输出',
  'terminal.expand': '展开其余 {n} 行',
  'terminal.expandAria': '展开被折叠的 {n} 行输出',
} as const

/** English dictionary, key-identical to the Chinese source of truth. */
export const en: Record<ActivityKey, string> = {
  'count.live.one': '{count} live activity',
  'count.live.other': '{count} live activities',
  'count.idle.one': '{count} activity',
  'count.idle.other': '{count} activities',
  'list.aria': 'Live activities',
  'row.expandAria': 'Show live output of {label}',
  'row.collapseAria': 'Hide live output of {label}',
  'status.running': 'running',
  'status.completed': 'completed',
  'status.killed': 'cancelled',
  'status.failed': 'failed',
  'output.gap': '… earlier output dropped …',
  'output.error': 'live output stream interrupted: {error}',
  'terminal.signal': 'signal {signal}',
  'terminal.exitCode': 'exit {code}',
  'terminal.running': 'running',
  'terminal.failed': 'failed',
  'terminal.done': 'done',
  'terminal.copy': 'Copy',
  'terminal.copied': 'Copied',
  'terminal.noOutput': '(no output)',
  'terminal.collapse': 'Collapse',
  'terminal.collapseAria': 'Collapse output',
  'terminal.expand': 'Show {n} more lines',
  'terminal.expandAria': 'Expand {n} collapsed output lines',
}

/** Key domain of the `activity` namespace (zh is the source of truth). */
export type ActivityKey = keyof typeof zh
