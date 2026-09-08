/**
 * `command` namespace dictionaries: the composer menu's section headings,
 * the client face (title, description, claim token) of the built-in Host
 * commands whose catalog descriptors carry English text only, the File row's
 * title, and the popupSelect shell's copy.
 */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'section.add': '添加',
  'section.commands': '指令',
  'label.file': '文件',
  'label.goal': '目标',
  'label.plan': '计划',
  'label.feedback': '反馈',
  'label.compact': '压缩',
  'label.permission': '权限',
  'label.export': '下载日志',
  'description.goal': '设置或查看长期任务的目标',
  'description.plan': '进入或退出计划模式',
  'description.feedback': '记录关于本会话的反馈',
  'description.compact': '压缩较早的对话历史',
  'description.permission': '切换权限预设（沙箱模式与审批策略）',
  'description.export': '将本会话日志下载为 ZIP 压缩包',
  'token.goal': '目标',
  'token.plan': '计划',
  'token.feedback': '反馈',
  'token.compact': '压缩',
  'token.permission': '权限',
  'token.export': '导出',
  'search.placeholder': '搜索…',
  'search.aria': '筛选选项',
  'status.loading': '正在加载选项…',
  'status.applying': '正在应用…',
  'status.empty': '无选项',
  'overlay.aria': '/{command} 选项',
  'listbox.aria': '/{command} 匹配项',
  'notice.attachmentsUnsupported': '/{command} 不接受附件，请先移除附件',
} satisfies Record<string, string>

/** The command namespace key union. */
export type CommandKey = keyof typeof zh

/**
 * English dictionary, checked complete against the zh key set. Each
 * `description.*` entry is byte-equal to the Host descriptor it localizes:
 * that equality is how a catalog row is recognized as the built-in command.
 */
export const en = {
  'section.add': 'Add',
  'section.commands': 'Commands',
  'label.file': 'File',
  'label.goal': 'Goal',
  'label.plan': 'Plan',
  'label.feedback': 'Feedback',
  'label.compact': 'Compact',
  'label.permission': 'Permission',
  'label.export': 'Export',
  'description.goal': 'Set or view the goal for a long-running task',
  'description.plan': 'Enter or leave plan mode',
  'description.feedback': 'Record feedback about this session',
  'description.compact': 'Compact older conversation history',
  'description.permission': 'Switch the permission preset (sandbox mode + approval policy)',
  'description.export': 'Download this Session log as a ZIP archive',
  'token.goal': 'goal',
  'token.plan': 'plan',
  'token.feedback': 'feedback',
  'token.compact': 'compact',
  'token.permission': 'permission',
  'token.export': 'export',
  'search.placeholder': 'Search…',
  'search.aria': 'Filter options',
  'status.loading': 'Loading options…',
  'status.applying': 'Applying…',
  'status.empty': 'No options',
  'overlay.aria': '/{command} options',
  'listbox.aria': '/{command} matches',
  'notice.attachmentsUnsupported': '/{command} does not accept attachments; remove them first',
} satisfies Record<CommandKey, string>
