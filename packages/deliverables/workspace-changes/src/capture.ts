/**
 * Whole-file captures around file-tool edits: the content of a path before
 * the turn's first mutation of it and at turn end, stored content-addressed
 * under the Session's temporary directory so both sides of a comparison
 * survive later edits without depending on git.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Bytes git inspects for a NUL byte before treating content as binary. */
const BINARY_PROBE_BYTES = 8000

/** One captured side of a path. */
export type Capture =
  /** No file at the path. */
  | { kind: 'absent' }
  /** A regular file larger than the configured cap; its content is not stored. */
  | { kind: 'oversized' }
  /** A stored copy, named by the SHA-1 of its bytes. */
  | { kind: 'file'; file: string; binary: boolean }

/** Whether a filesystem error names a missing path. */
function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
}

/**
 * Store the current content of one path.
 * @param absolute - canonical absolute path of the file.
 * @param directory - directory holding content-addressed copies; created when missing.
 * @param maxBytes - inclusive byte cap on a stored copy.
 * @returns the capture, or undefined for a path that is neither absent nor a regular file.
 */
export async function captureFile(absolute: string, directory: string, maxBytes: number): Promise<Capture | undefined> {
  let size: number
  try {
    const info = await stat(absolute)
    if (!info.isFile()) return undefined
    size = info.size
  } catch (error: unknown) {
    if (isMissing(error)) return { kind: 'absent' }
    throw error
  }
  if (size > maxBytes) return { kind: 'oversized' }
  const bytes = await readFile(absolute)
  if (bytes.byteLength > maxBytes) return { kind: 'oversized' }
  const file = join(directory, createHash('sha1').update(bytes).digest('hex'))
  await mkdir(directory, { recursive: true })
  // Identical content across paths and turns shares one copy; `wx` keeps an existing copy as is.
  await writeFile(file, bytes, { flag: 'wx' }).catch((error: unknown) => {
    if ((error as { code?: unknown }).code !== 'EEXIST') throw error
  })
  return { kind: 'file', file, binary: bytes.subarray(0, BINARY_PROBE_BYTES).includes(0) }
}

/** Whether two captures hold the same content. */
export function sameCapture(a: Capture, b: Capture): boolean {
  return a.kind === b.kind && (a.kind !== 'file' || b.kind !== 'file' || a.file === b.file)
}

/** A non-blank string, or undefined. */
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/**
 * The path a first-party file-tool call is about to mutate: `write`, `edit`,
 * and the mutating `str_replace_editor` commands. Other tools, reads, and
 * incomplete arguments yield undefined.
 * @param name - wire tool name.
 * @param args - parsed call arguments.
 * @returns the model-facing path, or undefined.
 */
export function mutationPath(name: string, args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return undefined
  const record = args as Record<string, unknown>
  switch (name) {
    case 'write':
      return typeof record.content === 'string' ? text(record.file_path) : undefined
    case 'edit':
      return typeof record.old_string === 'string' && typeof record.new_string === 'string' ? text(record.file_path) : undefined
    case 'str_replace_editor':
      return record.command === 'create' || record.command === 'str_replace' || record.command === 'insert' ? text(record.path) : undefined
    default:
      return undefined
  }
}
