/** Authorized Host PDFs remain binary through Client reuse and disposal. */
import type { OfficeToPdfGeneration } from '@deepseek-ai/dsh-office-to-pdf/types'
import { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-office-to-pdf/remote'
import { makeTranslate, RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import { DocumentPreviewRegistry } from '../src/client/document/registry.ts'
import { apply } from '../src/client/office/index.ts'
import { Config } from '../src/config.ts'
import { FontNotice } from '../src/client/office/FontNotice.tsx'
import { en, zh } from '../src/client/office/locales.ts'

const file = { sessionId: 's1' as SessionId, path: 'report.DOCX' }
const generation = ('renderer' as OfficeToPdfGeneration)
const source = { absolutePath: '/report.docx', version: 'v1', offset: 0, eof: true, bytes: 4, data: 'JVBERg==' }
const pdf = new Uint8Array([37, 80, 68, 70])
const converted = { ok: true as const, value: { ...source, generation, missingFonts: ['Missing Serif'] } }

async function harness(config: Partial<Config['office']> = {}, missing?: 'remote' | 'render' | 'files') {
  const ctx = new Context()
  const registry = new DocumentPreviewRegistry()
  const removeLocale = vi.fn()
  const locale = { register: vi.fn(() => removeLocale), bind: () => makeTranslate(en) }
  const render = vi.fn<ClientRemote['officeToPdf']['render']>().mockResolvedValue(converted)
  const rendererGeneration = vi.fn<ClientRemote['officeToPdf']['generation']>().mockResolvedValue({ ok: true, value: generation })
  const stat = vi.fn<ClientRemote['workspaceFiles']['stat']>().mockResolvedValue({ ok: true, value: source })
  const readBytes = vi.fn<ClientRemote['workspaceFiles']['readBytes']>().mockResolvedValue({ ok: true, value: source })
  const removeNotice = vi.fn()
  const register = vi.fn(() => removeNotice)
  ctx.provide('documentPreviews', registry)
  ctx.provide('slots', { inject: (_name: string, effect: () => () => void) => effect(), register } as never)
  ctx.provide('locale', locale as never)
  if (missing !== 'remote') {
    ctx.provide('remote', { workspaceFiles: { stat, readBytes }, officeToPdf: { render, generation: rendererGeneration } } as never)
    if (missing !== 'files') ctx.provide('remote.workspaceFiles', { stat, readBytes } as never)
    if (missing !== 'render') ctx.provide('remote.officeToPdf', { render, generation: rendererGeneration } as never)
  }
  const fiber = ctx.plugin({ apply: (scope: Context) => {
    apply(scope, Config({ office: config }).office)
  } })
  await fiber.await()
  return { ctx, registry, locale, removeLocale, render, rendererGeneration, stat, readBytes, register, removeNotice,
    read: (signal = new AbortController().signal, path = file.path) => registry.candidates(path)[0]!.read!({ ...file, path }, signal),
    close: () => fiber.dispose(),
  }
}

it.each(['remote', 'render', 'files'] as const)('keeps Office registration and guidance when %s is absent', async (missing) => {
  const h = await harness(undefined, missing)
  try {
    expect(h.locale.register).toHaveBeenCalledWith('sidebarOffice', { zh, en })
    for (const path of ['a.DOC', 'b.DOCX', 'c.XLS', 'd.xlsx', 'e.PPT', 'f.pptx']) {
      expect(h.registry.candidates(path)[0]!.binaryExtensions).toEqual(['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'])
      expect(h.registry.candidates(path)[0]!.title()).toBe(en.title)
      await expect(h.read(undefined, path)).rejects.toThrow(en.unavailable)
    }
    expect(h.render).not.toHaveBeenCalled()
  } finally { await h.close() }
  expect(h.registry.getSnapshot()).toEqual([])
  expect(h.removeLocale).toHaveBeenCalledOnce()
  expect(h.register).toHaveBeenCalledWith({
    name: 'sidebar.right.tab.document.notice', key: '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/office', locale: 'sidebarOffice',
  }, FontNotice)
  expect(h.removeNotice).toHaveBeenCalledTimes(2)
})

it('requests a Host PDF with source identity and borrows the same binary cache result', async () => {
  const h = await harness({ maxCachedBytes: pdf.byteLength })
  try {
    const result = await h.read()
    expect(h.render).toHaveBeenCalledExactlyOnceWith(file.sessionId, file.path, 'foreground', expect.any(AbortSignal))
    expect(result).toEqual({ ok: true, value: { ...source, data: pdf, generation, missingFonts: ['Missing Serif'] } })
    expect(await h.read()).toBe(result)
    expect(h.stat).toHaveBeenCalledTimes(2)
    expect(h.readBytes).toHaveBeenCalledTimes(2)
    expect(h.readBytes).toHaveBeenCalledWith(file.sessionId, file.path, { offset: 0, length: 1 }, expect.any(AbortSignal))
    expect(h.render).toHaveBeenCalledOnce()
  } finally { await h.close() }
})

it.each([
  ['rendererGeneration', 'gateway/invocation-unavailable'], ['rendererGeneration', 'gateway/service-unavailable'],
  ['render', 'gateway/invocation-unavailable'], ['render', 'gateway/service-unavailable'],
] as const)('shows configuration guidance when %s returns %s', async (method, code) => {
  const h = await harness()
  try {
    const endpoint = method === 'render' ? 'officeToPdf/render' : 'officeToPdf/generation'
    const failure = new RemoteError(code, 'Office provider is unavailable.', { endpoint })
    h[method].mockResolvedValueOnce({ ok: false, error: failure })
    await expect(h.read()).rejects.toMatchObject({ message: en.unavailable, cause: failure })
    expect((await h.read()).ok).toBe(true)
  } finally { await h.close() }
})

it('shows configuration guidance when the Host exposes no Office HTTP endpoint', async () => {
  const h = await harness()
  try {
    const failure = new RemoteError('gateway/internal', 'transport failure for /api/officeToPdf/generation: HTTP 404', {})
    h.rendererGeneration.mockResolvedValueOnce({ ok: false, error: failure })
    await expect(h.read()).rejects.toMatchObject({ message: en.unavailable, cause: failure })
    expect(h.readBytes).not.toHaveBeenCalled()
    expect(h.render).not.toHaveBeenCalled()
  } finally { await h.close() }
})

it('refuses Client cached bytes when metadata still succeeds but the read probe fails', async () => {
  const h = await harness()
  try {
    await h.read()
    const failure = new Error('read denied')
    h.readBytes.mockRejectedValueOnce(failure)
    await expect(h.read()).rejects.toBe(failure)
    expect(h.render).toHaveBeenCalledOnce()
    expect(h.stat).toHaveBeenCalledOnce()
  } finally { await h.close() }
})

it('returns a declared authorization failure without consulting metadata or cached bytes', async () => {
  const h = await harness()
  try {
    await h.read()
    const denied = { ok: false as const, error: new RemoteError('workspace-file/not-found', 'File missing', { path: file.path }) }
    h.readBytes.mockResolvedValueOnce(denied)
    expect(await h.read()).toBe(denied)
    expect(h.stat).toHaveBeenCalledOnce()
    expect(h.render).toHaveBeenCalledOnce()
  } finally { await h.close() }
})

it('localizes Client capacity rejection while another reader waits for source metadata', async () => {
  const h = await harness({ maxReaders: 1 })
  const entered = Promise.withResolvers<undefined>()
  const completed = Promise.withResolvers<Awaited<ReturnType<typeof h.stat>>>()
  h.stat.mockImplementationOnce(() => { entered.resolve(undefined); return completed.promise })
  const first = h.read()
  try {
    await entered.promise
    await expect(h.read()).rejects.toThrow(en.busy)
    expect(h.stat).toHaveBeenCalledOnce()
    expect(h.render).not.toHaveBeenCalled()
    completed.resolve({ ok: true, value: source })
    expect((await first).ok).toBe(true)
  } finally {
    completed.resolve({ ok: true, value: source })
    await first
    await h.close()
  }
})

it('refuses a source replaced during the Client authorization probe', async () => {
  const h = await harness()
  try {
    h.stat.mockResolvedValueOnce({ ok: true, value: { ...source, version: 'v2' } })
    await expect(h.read()).rejects.toThrow(en.changed)
    expect(h.render).not.toHaveBeenCalled()
  } finally { await h.close() }
})

it('passes source authorization failures through and rechecks permission before reuse', async () => {
  const h = await harness()
  try {
    const missing = { ok: false as const, error: new RemoteError('workspace-file/not-found', 'File missing', { path: file.path }) }
    h.render.mockResolvedValueOnce(missing)
    expect(await h.read()).toBe(missing)
    await h.read()
    h.stat.mockResolvedValueOnce(missing)
    expect(await h.read()).toBe(missing)
    expect(h.render).toHaveBeenCalledTimes(2)
  } finally { await h.close() }
})

it.each([
  ['input-too-large', 'tooLarge'], ['output-too-large', 'tooLarge'], ['invalid-document', 'invalid'],
  ['unsupported-format', 'invalid'], ['invalid-output', 'failed'], ['timeout', 'timeout'],
  ['unavailable', 'unavailable'], ['failed', 'failed'], ['busy', 'busy'], ['source-changed', 'changed'],
] as const)('localizes %s Host conversion failures and allows retry', async (code, key) => {
  const h = await harness()
  try {
    const failure = new RemoteError('document-render/failed', 'Office conversion failed.', { reason: code })
    h.render.mockResolvedValueOnce({ ok: false, error: failure })
    await expect(h.read()).rejects.toMatchObject({ message: en[key], cause: failure })
    expect((await h.read()).ok).toBe(true)
  } finally { await h.close() }
})

it('cancels the Host request on disposal and waits for its completion', async () => {
  const h = await harness()
  const completed = Promise.withResolvers<typeof converted>()
  const started = Promise.withResolvers<AbortSignal>()
  h.render.mockImplementation((_session, _path, _priority, signal) => { started.resolve(signal!); return completed.promise })
  const pending = h.read()
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  const signal = await started.promise
  let disposed = false
  const closing = h.close().then(() => { disposed = true })
  try {
    await rejected
    expect(signal.aborted).toBe(true)
    expect(disposed).toBe(false)
  } finally { completed.resolve(converted); await closing }
})

it('replaces cached PDFs on connection reset', async () => {
  const h = await harness()
  try {
    await h.read()
    await h.ctx.parallel('connection/reset')
    await h.read()
    expect(h.render).toHaveBeenCalledTimes(2)
  } finally { await h.close() }
})

it('joins a retired request during reset without retaining its late PDF in the new cache', async () => {
  const h = await harness()
  const completed = Promise.withResolvers<typeof converted>()
  const started = Promise.withResolvers<AbortSignal>()
  h.render.mockImplementationOnce((_session, _path, _priority, signal) => { started.resolve(signal!); return completed.promise })
  const pending = h.read()
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  const signal = await started.promise
  const resetting = h.ctx.parallel('connection/reset')
  try {
    await rejected
    expect(signal.aborted).toBe(true)
    await h.read()
    expect(h.render).toHaveBeenCalledTimes(2)
    let disposed = false
    const closing = h.close().then(() => { disposed = true })
    expect(disposed).toBe(false)
    completed.resolve(converted)
    await resetting
    await closing
  } finally { completed.resolve(converted); await resetting; await h.close() }
})
