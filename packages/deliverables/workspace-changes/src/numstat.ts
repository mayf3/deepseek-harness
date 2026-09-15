/** Line-count derivation from `git diff-tree --numstat -z` output and from recorded file-tool hunks. */
import { structuredPatch } from 'diff'
import type { FileDiff } from '@deepseek-ai/dsh-tools'

/** One `--numstat` record; `path` is slash-separated and relative to the repository root. */
export interface NumstatEntry {
  path: string
  added: number
  deleted: number
  binary: boolean
}

/**
 * Parse NUL-terminated numstat records. A rename record carries an empty path
 * followed by the old and new paths; only the new path is kept.
 * @param output - complete stdout of `git diff-tree -r -M -z --numstat`.
 * @returns records in git's output order.
 * @throws when a record is malformed, which indicates truncated output.
 */
export function parseNumstat(output: string): NumstatEntry[] {
  const queue = output.split('\0')
  if (queue.at(-1) !== '') throw new Error('numstat output is not NUL-terminated')
  queue.pop()
  const entries: NumstatEntry[] = []
  while (queue.length > 0) {
    const record = queue.shift() as string
    // Only the first two tabs separate fields; a file name keeps its own tabs.
    const first = record.indexOf('\t')
    const second = first < 0 ? -1 : record.indexOf('\t', first + 1)
    if (second < 0) throw new Error(`malformed numstat record: ${record}`)
    const added = record.slice(0, first)
    const deleted = record.slice(first + 1, second)
    const path = record.slice(second + 1)
    let target = path
    if (target === '') {
      queue.shift()
      const renamed = queue.shift()
      if (renamed === undefined) throw new Error('malformed numstat rename record')
      target = renamed
    }
    const binary = added === '-'
    entries.push({ path: target, added: binary ? 0 : Number(added), deleted: binary ? 0 : Number(deleted), binary })
  }
  return entries
}

/**
 * A side's text with every line terminated, so the last line compares by
 * content alone: the file tools persist hunk sides without a trailing newline,
 * and the same rule reads empty text as no lines rather than one empty line.
 */
function terminated(text: string): string {
  return text === '' || text.endsWith('\n') ? text : `${text}\n`
}

/**
 * Sum the added and deleted lines over recorded hunks. Context lines appear on
 * both sides of a hunk and cancel out; a hunk without prior text counts every
 * line as added; a trailing newline never counts as a changed line.
 * @param diffs - the applied hunks a file tool persisted with its result.
 * @returns line totals for one file.
 */
export function hunkLineCounts(diffs: readonly FileDiff[]): { added: number; deleted: number } {
  let added = 0
  let deleted = 0
  for (const diff of diffs) {
    const patch = structuredPatch('', '', terminated(diff.oldText ?? ''), terminated(diff.newText))
    for (const hunk of patch.hunks) {
      for (const line of hunk.lines) {
        if (line.startsWith('+')) added += 1
        else if (line.startsWith('-')) deleted += 1
      }
    }
  }
  return { added, deleted }
}

/**
 * Narrow a tool result's opaque `meta` to the file-tool hunk list.
 * @param meta - persisted result metadata.
 * @returns the hunks; an empty list for a `write` that updated a file without changing it; undefined when the
 * metadata carries none, as `write` persists for a created file, so the call's arguments supply the content.
 */
export function fileDiffsOf(meta: unknown): FileDiff[] | undefined {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined
  const { diffs, operation } = meta as Record<string, unknown>
  if (!Array.isArray(diffs)) return undefined
  if (diffs.length === 0) return operation === 'update' ? [] : undefined
  const out: FileDiff[] = []
  for (const value of diffs) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
    const { path, oldText, newText } = value as Record<string, unknown>
    if (typeof path !== 'string' || (oldText !== null && typeof oldText !== 'string') || typeof newText !== 'string') return undefined
    out.push({ path, oldText, newText })
  }
  return out
}

/** Non-blank string argument, or undefined. */
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/**
 * Hunks a first-party mutation call implies from its own arguments, for
 * results that persist no hunks: `write` creates, and every
 * `str_replace_editor` mutation. Malformed or non-mutating calls yield null.
 * @param name - wire tool name.
 * @param argumentsRaw - model-produced JSON arguments.
 * @returns the implied hunks, or null.
 */
export function argumentHunks(name: string, argumentsRaw: string): FileDiff[] | null {
  let args: unknown
  try {
    args = JSON.parse(argumentsRaw) as unknown
  } catch {
    return null
  }
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return null
  const record = args as Record<string, unknown>
  switch (name) {
    case 'write': {
      const path = text(record.file_path)
      return path !== undefined && typeof record.content === 'string' ? [{ path, oldText: null, newText: record.content }] : null
    }
    case 'edit': {
      const path = text(record.file_path)
      return path !== undefined && typeof record.old_string === 'string' && record.old_string !== '' && typeof record.new_string === 'string'
        ? [{ path, oldText: record.old_string, newText: record.new_string }]
        : null
    }
    case 'str_replace_editor': {
      const path = text(record.path)
      if (path === undefined) return null
      switch (record.command) {
        case 'create':
          return typeof record.file_text === 'string' ? [{ path, oldText: null, newText: record.file_text }] : null
        case 'str_replace':
          return typeof record.old_str === 'string' && record.old_str !== '' && (record.new_str === undefined || typeof record.new_str === 'string')
            ? [{ path, oldText: record.old_str, newText: record.new_str ?? '' }]
            : null
        case 'insert':
          return typeof record.new_str === 'string' ? [{ path, oldText: null, newText: record.new_str }] : null
        default:
          return null
      }
    }
    default:
      return null
  }
}
