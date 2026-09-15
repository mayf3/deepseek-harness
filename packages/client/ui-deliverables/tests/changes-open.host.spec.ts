/** The change summary route and the changed-file and common-folder native opens over the Host-served summaries. */
import { mkdtemp, rm, writeFile, mkdir, realpath, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { WorkspaceFiles } from '@deepseek-ai/dsh-api-workspace-files'
import { Context } from '@deepseek-ai/cordis'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import type { BrowserAuth } from '@deepseek-ai/dsh-client-connection/src/browser-auth.ts'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SessionQueryError } from '@deepseek-ai/dsh-session-query'
import type { SessionEventReadRequest } from '@deepseek-ai/dsh-session-query'
import type { WorkspaceChangedFile, WorkspaceChangesSummary } from '@deepseek-ai/dsh-workspace-changes/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { commonChangedFolder, registerPresentOpen } from '../src/present-open.ts'
import { changedFileUrl, changesSummaryUrl, CHANGES_OPEN_PATH, CHANGED_FILES_PATH, isChangedFile, isChangesEvent, isChangesSummary } from '../src/changes.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
  vi.restoreAllMocks()
})

const changed = (path: string, display = path): WorkspaceChangedFile => ({ path, display, added: 1, deleted: 0 })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-changes-open-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const cwd = join(root, 'workspace')
  await mkdir(join(cwd, 'src', 'lib'), { recursive: true })
  await writeFile(join(cwd, 'src', 'lib', 'a.ts'), 'a')
  await writeFile(join(cwd, 'src', 'b.ts'), 'b')
  const outside = join(root, 'outside.txt')
  await writeFile(outside, 'outside')
  const data: WorkspaceChangesSummary = {
    turn: 1, cwd, total: 3, added: 3, deleted: 0, snapshot: { before: 'a'.repeat(40), after: 'b'.repeat(40) },
    files: [changed('src/lib/a.ts'), changed('src/b.ts'), changed(outside, '~/outside.txt')],
  }
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(LocalFileSystem, { cwd })
  ctx.provide('sandboxPolicy', { workspaceRoot: cwd } as never)
  await ctx.plugin({
    inject: ['fs', 'sandboxPolicy'],
    apply: (scope) => { new WorkspaceFiles(scope, { maxBytes: 1024, maxFileBytes: 1024, maxLines: 100, maxEntries: 100 }) },
  })
  const readEvent = vi.fn(async (_request: SessionEventReadRequest) => {
    throw new SessionQueryError('missing', 'SESSION_QUERY_EVENT_NOT_FOUND')
  })
  ctx.provide('sessionQuery', { readEvent } as never)
  const summary = vi.fn((sessionId: SessionId, seq: number) => sessionId === 'owner' && seq === 9 ? data : undefined)
  ctx.provide('workspaceChanges', { summary })
  const opener = vi.fn(async (_request: { path: string; action?: 'reveal' }, _signal: AbortSignal) => ({ opened: true as const }))
  ctx.provide('sessionController', { openWorkspacePath: opener, workspaceDesktop: () => ({ name: 'desktop', available: true, fileManager: 'finder' }) } as never)
  const connection = new HostConnectionService(ctx, [], {} as BrowserAuth)
  await ctx.plugin({
    inject: ['connection', 'sessionQuery', 'sessionController', 'workspaceFiles', 'fs', 'sandboxPolicy', 'workspaceChanges'],
    apply: registerPresentOpen,
  })
  const handler = connection.createSharedFetchHandler('/api')
  const open = (query = '?sessionId=owner&seq=9&index=0') => handler.fetch(new Request(`http://localhost${CHANGES_OPEN_PATH}${query}`, { method: 'POST' }))
  const read = (query = '?sessionId=owner&seq=9') => handler.fetch(new Request(`http://localhost${CHANGED_FILES_PATH}${query}`))
  return { root, cwd, ctx, data, readEvent, open, read, opener, outside, summary }
}

describe('change summary route', () => {
  it('serves the Host-held summary without its working directory, and 404 once it is gone', async () => {
    const { read, data, summary } = await fixture()
    expect(changesSummaryUrl(SessionId('owner'), 9)).toBe(`${CHANGED_FILES_PATH}?sessionId=owner&seq=9`)
    const response = await read()
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    // The working directory and snapshot ids stay on the Host.
    expect(await response.json()).toEqual({ turn: 1, total: 3, added: 3, deleted: 0, files: data.files })
    expect((await read('?sessionId=owner&seq=8')).status).toBe(404)
    expect((await read('?sessionId=other&seq=9')).status).toBe(404)
    for (const bad of ['', '?seq=9', '?sessionId=owner', '?sessionId=owner&seq=x', '?sessionId=owner&seq=1.5']) {
      expect((await read(bad)).status).toBe(400)
    }
    expect(summary).toHaveBeenCalledTimes(3)
  })
})

describe('changed files native open route', () => {
  it('opens a listed file inside or outside the workspace with its verified Host path', async () => {
    const { cwd, open, opener, outside } = await fixture()
    expect(changedFileUrl(SessionId('owner'), 9, 0)).toBe(`${CHANGES_OPEN_PATH}?sessionId=owner&seq=9&index=0`)
    expect(changedFileUrl(SessionId('owner'), 9, null)).toBe(`${CHANGES_OPEN_PATH}?sessionId=owner&seq=9`)
    const response = await open()
    expect(response.status).toBe(204)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(opener).toHaveBeenLastCalledWith({ path: await realpath(join(cwd, 'src', 'lib', 'a.ts')) }, expect.any(AbortSignal))
    expect((await open('?sessionId=owner&seq=9&index=2')).status).toBe(204)
    expect(opener.mock.lastCall?.[0].path).toBe(await realpath(outside))
  })

  it('opens the deepest folder containing the workspace files, falling back to the workspace', async () => {
    const { cwd, open, opener, data } = await fixture()
    expect((await open('?sessionId=owner&seq=9')).status).toBe(204)
    expect(opener).toHaveBeenLastCalledWith({ path: await realpath(join(cwd, 'src')) }, expect.any(AbortSignal))
    data.files = [changed('../escaped.ts', '../escaped.ts'), changed('/etc/hosts', '/etc/hosts')]
    expect((await open('?sessionId=owner&seq=9')).status).toBe(204)
    expect(opener.mock.lastCall?.[0].path).toBe(await realpath(cwd))
    const w = resolve('/w')
    expect(commonChangedFolder(w, [changed('a/b/c.ts'), changed('a/d.ts'), changed(resolve('/x/y.ts'))])).toBe(resolve(w, 'a'))
    expect(commonChangedFolder(w, [changed(resolve('/x/y.ts'))])).toBe(w)
    expect(commonChangedFolder(w, [changed('../up.ts')])).toBe(w)
  })

  it.each(['', '?seq=9', '?sessionId=owner', '?sessionId=owner&seq=9&index=-1', '?sessionId=owner&seq=9&index=1.5', '?sessionId=owner&seq=x'])(
    'rejects invalid coordinates before reading: %s', async (query) => {
      const { open, readEvent } = await fixture()
      expect((await open(query)).status).toBe(400)
      expect(readEvent).not.toHaveBeenCalled()
    })

  it('refuses unrelated Sessions, forgotten summaries, unknown indices, and missing files', async () => {
    const { open, readEvent, opener, cwd } = await fixture()
    expect((await open('?sessionId=other&seq=9&index=0')).status).toBe(404)
    expect((await open('?sessionId=owner&seq=8&index=0')).status).toBe(404)
    expect((await open('?sessionId=owner&seq=9&index=5')).status).toBe(404)
    expect(readEvent).not.toHaveBeenCalled()
    await unlink(join(cwd, 'src', 'lib', 'a.ts'))
    expect((await open()).status).toBe(404)
    await rm(join(cwd, 'src'), { recursive: true })
    expect((await open('?sessionId=owner&seq=9')).status).toBe(404)
    expect(opener).not.toHaveBeenCalled()
  })

  it('refuses opening without a desktop or a verified Host mapping and reports launcher failures', async () => {
    const { ctx, open, opener } = await fixture()
    const desktop = vi.spyOn(ctx.sessionController, 'workspaceDesktop').mockReturnValue({ name: 'desktop', available: false, fileManager: null })
    expect((await open()).status).toBe(409)
    desktop.mockRestore()
    const mapping = vi.spyOn(ctx.fs, 'processPathFromHostPath').mockReturnValue(undefined)
    expect((await open()).status).toBe(422)
    expect((await open('?sessionId=owner&seq=9')).status).toBe(422)
    mapping.mockRestore()
    opener.mockRejectedValueOnce(new Error('/private/host/path'))
    const failed = await open()
    expect(failed.status).toBe(500)
    expect(await failed.text()).not.toContain('/private/host/path')
    expect((await open()).status).toBe(204)
  })

  it('validates served summaries and logged announcements', () => {
    expect(isChangedFile({ path: 'a', display: 'a', added: 1, deleted: 2, binary: true })).toBe(true)
    expect(isChangedFile({ path: 'a', display: 'a', added: 1, deleted: 2, binary: false })).toBe(false)
    expect(isChangedFile({ path: '', display: 'a', added: 1, deleted: 2 })).toBe(false)
    expect(isChangedFile({ path: 'a', display: '', added: 1, deleted: 2 })).toBe(false)
    expect(isChangedFile({ path: 'a', display: 'a', added: 1.5, deleted: 2 })).toBe(false)
    expect(isChangedFile([])).toBe(false)
    expect(isChangesSummary({ turn: 1, total: 0, added: 0, deleted: 0, files: [] })).toBe(true)
    expect(isChangesSummary({ turn: 1, total: 1, added: 1, deleted: 0, files: [{ path: 'a', display: 'a', added: 1, deleted: 0 }] })).toBe(true)
    expect(isChangesSummary({ turn: '1', total: 0, added: 0, deleted: 0, files: [] })).toBe(false)
    expect(isChangesSummary({ turn: 0, total: 0, added: 0, deleted: 0, files: [] })).toBe(false)
    expect(isChangesSummary({ turn: 1, total: 1.5, added: 0, deleted: 0, files: [] })).toBe(false)
    expect(isChangesSummary({ turn: 1, total: 0, files: [] })).toBe(false)
    expect(isChangesSummary({ turn: 1, total: 0, added: 0, deleted: 'x', files: [] })).toBe(false)
    expect(isChangesSummary({ turn: 1, total: 1, added: 1, deleted: 0, files: [{ path: 'a' }] })).toBe(false)
    expect(isChangesSummary([])).toBe(false)
    expect(isChangesEvent({ turn: 1 })).toBe(true)
    expect(isChangesEvent({ turn: 1, extra: true })).toBe(true)
    expect(isChangesEvent({ turn: 0 })).toBe(false)
    expect(isChangesEvent({ turn: '1' })).toBe(false)
    expect(isChangesEvent(null)).toBe(false)
  })
})
