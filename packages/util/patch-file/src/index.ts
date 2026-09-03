/**
 * Loader patch-list files — the `cordis.patch.yml` layers a profile, a
 * bundle, a `--patch` overlay, and an agent preset's user layer are written
 * in: a top-level YAML sequence of `@deepseek-ai/cordis-plugin-include`
 * `PatchOptions` (id-targeted overrides and `insert` lists) in the Loader's
 * own dialect, where `!!js` marks an expression the row's fiber evaluates.
 *
 * One home for both directions. {@link parsePatchList} is the parser every
 * reader of such a file shares, so a file the boot accepts is a file every
 * other consumer accepts. {@link PatchDocument} edits one file at the key
 * level while keeping its comments, blank lines, and `!!js` scalars as the
 * author wrote them, and {@link mutatePatchFile} commits one edit under the
 * cross-process writer lock, through an atomic replace, and reads the result
 * back through the parser before reporting success.
 * @module @deepseek-ai/dsh-patch-file
 */

import { mkdir, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as yaml from 'js-yaml'
import { Document, isMap, isSeq, parseDocument, YAMLMap, YAMLSeq } from 'yaml'
import { entryListSchema, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

/**
 * Resolve relative plugin paths in one patch list's `insert` rows against the
 * file's own directory, without changing assertion names. A row naming
 * `./plugin.js` means the file beside the patch file, wherever the Loader's
 * root happens to be.
 * @param patches - the parsed patch list, mutated in place.
 * @param file - the patch file's path, whose directory anchors the names.
 * @returns the same list.
 */
export function anchorInsertedPluginNames(patches: PatchOptions[], file: string): PatchOptions[] {
  const base = dirname(resolve(file))
  const visit = (entry: EntryOptions): void => {
    if (typeof entry.name === 'string' && (entry.name.startsWith('./') || entry.name.startsWith('../'))) {
      entry.name = pathToFileURL(resolve(base, entry.name)).href
    }
    if (entry.group && Array.isArray(entry.config)) entry.config.forEach(visit)
  }
  for (const patch of patches) patch.insert?.forEach(visit)
  return patches
}

/**
 * Parse one loader patch list: a top-level YAML array of `PatchOptions`
 * (id-targeted config overrides and `insert` lists, `!!js` expressions
 * allowed). Every invalid field or value throws, because a patch file that
 * cannot be applied at all is a misconfiguration; a single patch whose target
 * row is absent stays a per-entry Loader warning, so one overlay shared
 * across surfaces does not have to match every tree.
 * @param binName - the diagnostic prefix on the thrown error.
 * @param file - the source path, quoted in errors and anchoring relative names.
 * @param content - the file's text.
 * @param label - what to call this list in errors (`patches`, `overlay`).
 * @returns the parsed patch list.
 */
export function parsePatchList(
  binName: string, file: string, content: string, label: string,
): PatchOptions[] {
  let parsed: unknown
  try {
    parsed = yaml.load(content, { schema: entryListSchema })
  } catch (error) {
    throw new Error(`${binName}: failed to parse ${label} ${file}: ${String(error)}`)
  }
  // An empty file is an empty layer: js-yaml reads it as undefined.
  if (parsed === undefined || parsed === null) return []
  if (!Array.isArray(parsed)) {
    throw new Error(`${binName}: ${label} ${file} must be a top-level YAML array of loader patch entries`)
  }
  parsed.forEach((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`${binName}: ${label} entry ${String(index + 1)} in ${file} must be a mapping (a loader patch entry)`)
    }
  })
  return anchorInsertedPluginNames(parsed as PatchOptions[], file)
}

/**
 * Read and parse one patch-list file.
 * @param binName - the diagnostic prefix on the thrown error.
 * @param file - absolute path of the file.
 * @param label - what to call this list in errors (`patches`, `overlay`).
 * @returns the parsed list, or undefined when the file does not exist.
 * @throws when the file exists but cannot be read or parsed.
 */
export async function readPatchListFile(binName: string, file: string, label: string): Promise<PatchOptions[] | undefined> {
  let content: string
  try {
    content = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return undefined
    throw new Error(`${binName}: failed to read ${label} ${file}: ${String(error)}`)
  }
  return parsePatchList(binName, file, content, label)
}

/** One inserted row as the writer addresses it: the Loader's row options. */
export type PatchRow = EntryOptions

/**
 * One patch-list file held as a comment-preserving document.
 *
 * Edits address rows by id the way the Loader does: an id-targeted patch is
 * the top-level item whose `id` matches and that carries no `insert`; an
 * inserted row is found inside any `insert` list, recursing into inserted
 * groups. Values written are plain data; a `!!js` scalar the author wrote on
 * another key is left exactly as it stands.
 */
export class PatchDocument {
  private readonly document: Document
  private readonly root: YAMLSeq
  private edited = false

  private constructor(document: Document, root: YAMLSeq) {
    this.document = document
    this.root = root
  }

  /** Whether any edit changed the document since it was parsed. */
  get dirty(): boolean {
    return this.edited
  }

  /**
   * Remove one item from a sequence, keeping the comment block written above
   * it: the comment moves to the following item, or becomes the document's
   * trailing comment when the removed item was the last one. Without this a
   * user's note above a row would vanish with the row it happened to precede.
   */
  private splice(seq: YAMLSeq, item: YAMLMap): void {
    const index = seq.items.indexOf(item)
    seq.items.splice(index, 1)
    this.edited = true
    const comment = item.commentBefore
    if (comment === null || comment === undefined) return
    const next = seq.items[index]
    if (isMap(next)) {
      next.commentBefore = next.commentBefore === null || next.commentBefore === undefined
        ? comment
        : `${comment}\n${next.commentBefore}`
      return
    }
    // Prepended: items are removed from the end one at a time, so the file's
    // own order survives in the trailing comment.
    this.document.comment = this.document.comment === null
      ? comment
      : `${comment}\n${this.document.comment}`
  }

  /**
   * Parse a patch-list file's text.
   * @param text - the file's text; empty or comment-only text is an empty list.
   * @param file - the path, quoted in errors.
   * @returns the document.
   * @throws when the text is not valid YAML or its root is not a sequence.
   */
  static parse(text: string, file: string): PatchDocument {
    // Typed as the general document: a comment-only file parses with no
    // contents, and the empty sequence assigned then is not a parsed node.
    const document: Document = parseDocument(text, { prettyErrors: true })
    // First line only: the parser appends a multi-line code frame.
    const problems = document.errors.map(error => error.message.replace(/\n[\s\S]*$/, ''))
    if (problems.length > 0) {
      throw new Error(`patch-file: ${file} is not valid YAML: ${problems.join('; ')}`)
    }
    let root: unknown = document.contents
    if (root === null) {
      root = new YAMLSeq()
      document.contents = root as YAMLSeq
    }
    if (!isSeq(root)) {
      throw new Error(`patch-file: ${file} must be a top-level YAML array of loader patch entries`)
    }
    for (const [index, item] of root.items.entries()) {
      if (!isMap(item)) {
        throw new Error(`patch-file: entry ${String(index + 1)} in ${file} must be a mapping (a loader patch entry)`)
      }
    }
    return new PatchDocument(document, root)
  }

  /** The top-level patch items, each a mapping. */
  private get items(): YAMLMap[] {
    return this.root.items as YAMLMap[]
  }

  /** The id-targeted patch for `id`: the item with that id and no `insert`. */
  private targeted(id: string): YAMLMap | undefined {
    return this.items.find(item => !item.has('insert') && item.get('id') === id)
  }

  /**
   * Whether an id-targeted patch for `id` exists.
   * @param id - the row id the patch targets.
   * @returns true when the file carries one.
   */
  hasRow(id: string): boolean {
    return this.targeted(id) !== undefined
  }

  /**
   * One key of the id-targeted patch for `id`, as plain data.
   * @param id - the row id the patch targets.
   * @param key - the patch key.
   * @returns the value, or undefined when the patch or the key is absent. A
   * `!!js` scalar reads as its source text.
   */
  rowField(id: string, key: string): unknown {
    const patch = this.targeted(id)
    if (patch === undefined || !patch.has(key)) return undefined
    return patch.get(key)
  }

  /**
   * Set one key on the id-targeted patch for `id`, creating the patch when the
   * file has none. Other keys of the patch and every comment stay.
   * @param id - the row id the patch targets.
   * @param key - the patch key (`disabled`, `config`, ...); never `id`.
   * @param value - plain data to write.
   */
  setRowField(id: string, key: string, value: unknown): void {
    if (key === 'id' || key === 'insert') {
      throw new Error(`patch-file: ${key} is not a settable key of an id-targeted patch`)
    }
    let patch = this.targeted(id)
    if (patch === undefined) {
      patch = new YAMLMap()
      patch.set('id', id)
      this.root.add(patch)
    }
    patch.set(key, this.document.createNode(value))
    this.edited = true
  }

  /**
   * Delete one key from the id-targeted patch for `id`; a patch left with
   * only its id is removed whole, so an override fully reverted leaves no
   * trace.
   * @param id - the row id the patch targets.
   * @param key - the patch key to delete.
   * @returns true when the key was present.
   */
  deleteRowField(id: string, key: string): boolean {
    const patch = this.targeted(id)
    if (patch === undefined || !patch.has(key)) return false
    patch.delete(key)
    this.edited = true
    const remaining = patch.items.map(pair => String(pair.key))
    if (remaining.length === 1 && remaining[0] === 'id') this.splice(this.root, patch)
    return true
  }

  /** Every `insert` list in the file, with the group id each targets. */
  private insertLists(): { patch: YAMLMap; into: string | undefined; rows: YAMLSeq }[] {
    const found: { patch: YAMLMap; into: string | undefined; rows: YAMLSeq }[] = []
    for (const patch of this.items) {
      if (!patch.has('insert')) continue
      const rows = patch.get('insert', true)
      if (!isSeq(rows)) {
        throw new Error('patch-file: an insert patch must hold a list of rows')
      }
      const into = patch.get('id')
      found.push({ patch, into: typeof into === 'string' ? into : undefined, rows })
    }
    return found
  }

  /**
   * Append one row to the `insert` list targeting `into` (the root list when
   * omitted), creating the patch when the file has none for that target.
   * @param row - the row options to insert; plain data.
   * @param into - the id of the group the row goes into, or undefined for the root.
   * @throws when a row with the same id is already inserted by this file.
   */
  appendInsert(row: PatchRow, into?: string): void {
    if (typeof row.id === 'string' && this.insertedRow(row.id) !== undefined) {
      throw new Error(`patch-file: row ${JSON.stringify(row.id)} is already inserted by this file`)
    }
    this.edited = true
    const list = this.insertLists().find(candidate => candidate.into === into)
    if (list !== undefined) {
      list.rows.add(this.document.createNode(row))
      return
    }
    this.root.add(this.document.createNode({
      ...into === undefined ? {} : { id: into },
      insert: [row],
    }))
  }

  /** Walk one row list for the row with `id`, recursing into inserted groups. */
  private static findInserted(rows: YAMLSeq, id: string): { parent: YAMLSeq; row: YAMLMap } | undefined {
    for (const item of rows.items) {
      if (!isMap(item)) continue
      if (item.get('id') === id) return { parent: rows, row: item }
      if (item.get('group') !== true) continue
      const nested = item.get('config', true)
      if (!isSeq(nested)) continue
      const found = PatchDocument.findInserted(nested, id)
      if (found !== undefined) return found
    }
    return undefined
  }

  /**
   * One row this file inserts, as plain data.
   * @param id - the inserted row's id.
   * @returns the row options, or undefined when this file inserts no such row.
   */
  insertedRow(id: string): PatchRow | undefined {
    for (const list of this.insertLists()) {
      const found = PatchDocument.findInserted(list.rows, id)
      if (found !== undefined) return found.row.toJSON() as PatchRow
    }
    return undefined
  }

  /**
   * Remove one row this file inserts; an `insert` patch left empty is removed
   * whole.
   * @param id - the inserted row's id.
   * @returns true when the row was present.
   */
  removeInsert(id: string): boolean {
    for (const list of this.insertLists()) {
      const found = PatchDocument.findInserted(list.rows, id)
      if (found === undefined) continue
      this.splice(found.parent, found.row)
      if (list.rows.items.length === 0) this.splice(this.root, list.patch)
      return true
    }
    return false
  }

  /**
   * Render the document as text, comments and `!!js` scalars intact.
   * @returns the YAML text, ending in one newline; an empty list renders as `[]`.
   */
  toString(): string {
    return this.document.toString()
  }
}

/** Filesystem options for {@link mutatePatchFile}. */
export interface MutatePatchFileOptions {
  /** The diagnostic prefix on thrown errors. */
  binName: string
  /** Permission bits for the replaced file; required so the decision stays at the call site. */
  mode: number
  /** Permission bits for parent directories this call creates. */
  dirMode?: number
  /** Maximum time to wait for the writer lock, in milliseconds. */
  waitMs?: number
}

/**
 * Apply one edit to a patch-list file: take the cross-process writer lock,
 * read the file (absent reads as empty), let `mutate` edit the document,
 * replace the file atomically, and parse the written text back through
 * {@link parsePatchList} so the caller learns what every reader will now
 * load. An edit that changes nothing writes nothing.
 * @param file - absolute path of the patch-list file.
 * @param mutate - the edit, applied to the parsed document.
 * @param options - diagnostics, permissions, and lock wait.
 * @returns the patch list as re-read from the file after the write.
 * @throws when the file cannot be parsed, the lock cannot be taken, or the
 * written file does not parse — the last is reported after the write landed.
 */
export async function mutatePatchFile(
  file: string,
  mutate: (document: PatchDocument) => void,
  options: MutatePatchFileOptions,
): Promise<PatchOptions[]> {
  await mkdir(dirname(file), { recursive: true, ...options.dirMode === undefined ? {} : { mode: options.dirMode } })
  return await withFileLock(file, async () => {
    let before: string
    try {
      before = await readFile(file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') {
        throw new Error(`${options.binName}: failed to read patches ${file}: ${String(error)}`)
      }
      before = ''
    }
    const document = PatchDocument.parse(before, file)
    mutate(document)
    if (!document.dirty) return parsePatchList(options.binName, file, before, 'patches')
    const after = document.toString()
    await writeFileAtomic(file, after, { mode: options.mode, ...options.dirMode === undefined ? {} : { dirMode: options.dirMode } })
    return parsePatchList(options.binName, file, after, 'patches')
  }, options.waitMs === undefined ? undefined : { waitMs: options.waitMs })
}
