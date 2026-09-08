/** `deliverables` namespace dictionaries. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'deliverables'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'presented.label': '交付文件',
  'presented.action': '下载',
  'presented.file': '文件',
  'row.title': '交付文件',
  'row.running': '正在交付',
  'row.ok': '已交付',
  'row.error': '交付失败',
  'row.stopped': '已中断',
  'row.inspect': '查看调用',
  'presented.download': '下载 {name}',
  'produced.label': '产物',
  'produced.moreOne': '+ 1 个文件',
  'produced.more': '+ {count} 个文件',
  'produced.open': '打开 {name}',
}

/** English dictionary (same key set). */
export const en: Record<DeliverablesKey, string> = {
  'presented.label': 'Deliverables',
  'presented.action': 'Download',
  'presented.file': 'File',
  'row.title': 'Present files',
  'row.running': 'Delivering',
  'row.ok': 'Delivered',
  'row.error': 'Delivery failed',
  'row.stopped': 'Interrupted',
  'row.inspect': 'Inspect call',
  'presented.download': 'Download {name}',
  'produced.label': 'Produced',
  'produced.moreOne': '+ 1 file',
  'produced.more': '+ {count} files',
  'produced.open': 'Open {name}',
}

/** Union of this namespace's dictionary keys. */
export type DeliverablesKey = keyof typeof zh
