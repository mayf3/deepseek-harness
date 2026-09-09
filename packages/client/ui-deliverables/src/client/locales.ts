/** `deliverables` namespace dictionaries. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'deliverables'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'presented.label': '交付文件',
  'presented.action': '打开',
  'presented.opening': '正在打开…',
  'presented.opened': '已在默认程序中打开',
  'presented.error': '打开失败，点击重试',
  'presented.file': '文件',
  'row.title': '交付文件',
  'row.running': '正在交付',
  'row.ok': '已交付',
  'row.error': '交付失败',
  'row.stopped': '已中断',
  'row.inspect': '查看调用',
  'presented.open': '在默认程序中打开 {name}',
  'produced.label': '本轮文件改动',
  'produced.moreOne': '+ 1 个文件',
  'produced.more': '+ {count} 个文件',
  'produced.open': '打开 {name}',
}

/** English dictionary (same key set). */
export const en: Record<DeliverablesKey, string> = {
  'presented.label': 'Deliverables',
  'presented.action': 'Open',
  'presented.opening': 'Opening…',
  'presented.opened': 'Opened in default app',
  'presented.error': 'Could not open. Click to retry.',
  'presented.file': 'File',
  'row.title': 'Present files',
  'row.running': 'Delivering',
  'row.ok': 'Delivered',
  'row.error': 'Delivery failed',
  'row.stopped': 'Interrupted',
  'row.inspect': 'Inspect call',
  'presented.open': 'Open {name} in default app',
  'produced.label': 'Files changed',
  'produced.moreOne': '+ 1 file',
  'produced.more': '+ {count} files',
  'produced.open': 'Open {name}',
}

/** Union of this namespace's dictionary keys. */
export type DeliverablesKey = keyof typeof zh
