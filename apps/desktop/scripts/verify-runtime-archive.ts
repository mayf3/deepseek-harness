/** Verify runtime bytes and executable permissions using ASAR records and physical unpacked files. */
import { createHash } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { readAsar, type Node } from 'app-builder-lib/out/asar/asar.js'
import type { DesktopRuntimeFile } from '../src/runtime-tree.ts'

/**
 * Compare the complete archived dsh tree with the sealed preparation inventory.
 * @param archivePath - Application ASAR file beside its unpacked directory.
 * @param expected - Verified preparation inventory, excluding the descriptor itself.
 * @returns Resolves when bytes, file membership and meaningful executable permissions match.
 */
export async function verifyRuntimeArchive(archivePath: string, expected: readonly DesktopRuntimeFile[]): Promise<void> {
  const archive = await readAsar(archivePath)
  const files: DesktopRuntimeFile[] = []
  async function visit(node: Node, path: string): Promise<void> {
    if (node.link !== undefined) throw new Error(`desktop runtime: unexpected ASAR link ${path}`)
    if (node.files !== undefined) {
      for (const [name, child] of Object.entries(node.files)) await visit(child, path === '' ? name : `${path}/${name}`)
      return
    }
    if (path === 'desktop-runtime.json') return
    const name = join('dsh', ...path.split('/'))
    const physical = node.unpacked === true ? await lstat(join(`${archivePath}.unpacked`, name)) : undefined
    if (physical !== undefined && !physical.isFile()) throw new Error(`desktop runtime: unexpected unpacked entry ${path}`)
    const body = await archive.readFile(name)
    const executable = process.platform !== 'win32' && (physical !== undefined
      ? (physical.mode & 0o111) !== 0
      : node.executable === true)
    files.push({ path, bytes: body.byteLength, sha256: createHash('sha256').update(body).digest('hex'), executable })
  }
  await visit(archive.getFile('dsh', false), '')
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  if (JSON.stringify(files) !== JSON.stringify(expected)) throw new Error('desktop runtime: ASAR integrity verification failed')
}
