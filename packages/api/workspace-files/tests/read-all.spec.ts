/** Full-file reads retain the ordinary file gates and never return a silently truncated result. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { FsVersion } from '@deepseek-ai/dsh-fs'
import { agent, failureOf, openWorkspace, signal, type Harness } from './harness.ts'

let harness: Harness

beforeEach(async () => { harness = await openWorkspace('dsh-workspace-files-read-all-') })
afterEach(async () => { await harness.dispose() })

describe('workspaceFiles.readAll', () => {
  it('reads the complete bytes independently of the window cap', async () => {
    const bytes = Buffer.from([0, 255, 1, 2])
    await writeFile(join(harness.workspace, 'file.bin'), bytes)
    const result = await harness.endpoint({ maxBytes: 1, maxFileBytes: 4 }).readAll(agent, 'file.bin', signal())
    expect(Buffer.from(result.data, 'base64')).toEqual(bytes)
    expect(result).toMatchObject({ offset: 0, eof: true, bytes: 4 })
  })

  it('returns an empty complete file', async () => {
    await writeFile(join(harness.workspace, 'empty'), '')
    expect(await harness.endpoint().readAll(agent, 'empty', signal())).toMatchObject({ data: '', offset: 0, eof: true, bytes: 0 })
  })

  it('rejects a known oversized file before reading bytes', async () => {
    await writeFile(join(harness.workspace, 'large'), 'abcde')
    const read = vi.spyOn(harness.ctx.fs, 'readByteRange')
    expect(await failureOf(harness.endpoint({ maxFileBytes: 4 }).readAll(agent, 'large', signal())))
      .toEqual({ code: 'workspace-file/too-large', details: { path: 'large', limit: 4 } })
    expect(read).not.toHaveBeenCalled()
  })

  it.each([undefined, 1])('checks the actual bytes when stat reports %s', async (size) => {
    await writeFile(join(harness.workspace, 'growing'), 'abcde')
    vi.spyOn(harness.ctx.fs, 'stat').mockResolvedValue({ type: 'file', version: FsVersion('v'), ...size === undefined ? {} : { size } })
    expect((await failureOf(harness.endpoint({ maxFileBytes: 4 }).readAll(agent, 'growing', signal()))).code)
      .toBe('workspace-file/too-large')
  })

  it('retains missing-file, kind and workspace confinement failures', async () => {
    await mkdir(join(harness.workspace, 'directory'))
    await writeFile(join(harness.outside, 'outside'), 'outside')
    const files = harness.endpoint()
    expect((await failureOf(files.readAll(agent, 'missing', signal()))).code).toBe('workspace-file/not-found')
    expect((await failureOf(files.readAll(agent, 'directory', signal()))).code).toBe('workspace-file/not-regular-file')
    expect((await failureOf(files.readAll(agent, join(harness.outside, 'outside'), signal()))).code).toBe('workspace-file/outside-workspace')
  })
})

describe('workspaceFiles.readRelated', () => {
  it('resolves relative paths from the base file directory on the Host', async () => {
    await mkdir(join(harness.workspace, 'nested'))
    await writeFile(join(harness.workspace, 'nested/base.txt'), 'base')
    await writeFile(join(harness.workspace, 'nested/near.txt'), 'near')
    await writeFile(join(harness.workspace, 'root.txt'), 'root')
    const files = harness.endpoint()
    const near = await files.readRelated(agent, 'nested/base.txt', './near.txt', signal())
    const root = await files.readRelated(agent, 'nested/base.txt', '../root.txt', signal())
    expect(Buffer.from(near.data, 'base64').toString()).toBe('near')
    expect(Buffer.from(root.data, 'base64').toString()).toBe('root')
    const fromRoot = await files.readRelated(agent, 'root.txt', 'nested\\near.txt', signal())
    expect(Buffer.from(fromRoot.data, 'base64').toString()).toBe('near')
  })

  it.each(['', '/outside', 'C:\\outside', '\\\\host\\share', 'https://example.test/a.js', 'bad\0path'])('rejects non-relative path %j', async (path) => {
    expect((await failureOf(harness.endpoint().readRelated(agent, 'base', path, signal()))).code).toBe('gateway/bad-request')
  })

  it('keeps base-file and target-file access checks', async () => {
    await writeFile(join(harness.workspace, 'base'), 'base')
    await writeFile(join(harness.outside, 'secret'), 'secret')
    const files = harness.endpoint()
    expect((await failureOf(files.readRelated(agent, 'missing', 'file', signal()))).code).toBe('workspace-file/not-found')
    expect((await failureOf(files.readRelated(agent, join(harness.outside, 'secret'), '../file', signal()))).code).toBe('workspace-file/outside-workspace')
    expect((await failureOf(files.readRelated(agent, 'base', '../outside/secret', signal()))).code).toBe('workspace-file/outside-workspace')
  })

  it('rejects a related symlink rather than following it', async () => {
    await writeFile(join(harness.workspace, 'base'), 'base')
    await writeFile(join(harness.workspace, 'target'), 'target')
    await symlink('target', join(harness.workspace, 'link'))
    expect((await failureOf(harness.endpoint().readRelated(agent, 'base', 'link', signal()))).code).toBe('workspace-file/not-regular-file')
  })
})
