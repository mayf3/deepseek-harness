/** Office preview registration backed by authorized Host rendering and the existing PDF body. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-api-document-render-controller/remote'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-api-workspace-files/remote'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import { documentFileBytes, type ReadDocumentBytes } from '../rpc.ts'
import { en, zh, type OfficePreviewKey } from './locales.ts'
import { OfficePreviewCache, type ReadOfficeBytes } from './cache.ts'
import { FontNotice } from './FontNotice.tsx'
import type { Config } from '../../config.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    sidebarOffice: OfficePreviewKey
  }
}

/**
 * Register Office previews with versioned PDF reuse and missing-font notices.
 * @param ctx - Client renderer registry, localized copy, and optional Host Remotes.
 * @param config - Resolved Office preview cache limits.
 */
export function apply(ctx: Context, config: Config['office']): void {
  const id = '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/office'
  ctx.effect(() => ctx.locale.register('sidebarOffice', { zh, en }))
  ctx.effect(() => ctx.slots.inject('sidebar.right.tab.document.notice', () => ctx.slots.register({
    name: 'sidebar.right.tab.document.notice', key: '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/office',
    locale: 'sidebarOffice',
  }, FontNotice)))
  const t = ctx.locale.bind('sidebarOffice')
  const unavailable: ReadDocumentBytes = (_file, signal) => {
    signal.throwIfAborted()
    return Promise.reject(new Error(t('unavailable')))
  }
  let read = unavailable
  ctx.effect(() => ctx.documentPreviews.register({
    id,
    bodyId: '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/pdf',
    extensions: ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'], priority: 'builtin',
    title: () => t('title'), loading: 'bytes-complete', wrap: false,
    read: (file, signal) => read(file, signal),
  }))
  ctx.inject(['remote', 'remote.documentRender', 'remote.workspaceFiles'], (scope) => {
    const convert: ReadOfficeBytes = async (file, signal, priority) => {
      signal.throwIfAborted()
      const result = await scope.remote.documentRender.render(file.sessionId, file.path, priority, signal)
      signal.throwIfAborted()
      if (!result.ok) {
        if (result.error.code === 'document-render/failed') {
          throw new Error(t(conversionErrorKey(result.error.details.reason)), { cause: result.error })
        }
        return result
      }
      return { ok: true, value: documentFileBytes(result.value) }
    }
    const createCache = () => new OfficePreviewCache(
      async (file, signal) => {
        const authorized = await scope.remote.workspaceFiles.readBytes(file.sessionId, file.path, { offset: 0, length: 1 }, signal)
        signal.throwIfAborted()
        if (!authorized.ok) return authorized
        const metadata = await scope.remote.workspaceFiles.stat(file.sessionId, file.path, signal)
        if (metadata.ok && (authorized.value.absolutePath !== metadata.value.absolutePath
          || authorized.value.version !== metadata.value.version)) {
          throw new Error(t('changed'))
        }
        return metadata
      },
      convert, config.maxCachedEntries, config.maxCachedBytes, config.maxPending, config.maxReaders,
      signal => scope.remote.documentRender.generation(signal), () => new Error(t('busy')),
    )
    let cache = createCache()
    const retired = new Set<Promise<void>>()
    read = (file, signal) => cache.read(file, signal)
    scope.on('connection/reset', () => {
      const previous = cache
      cache = createCache()
      const closing = previous.dispose().finally(() => { retired.delete(closing) })
      retired.add(closing)
    })
    scope.effect(() => async () => { read = unavailable; await Promise.all([...retired, cache.dispose()]) })
  })
}

function conversionErrorKey(code: string): OfficePreviewKey {
  switch (code) {
    case 'input-too-large': case 'output-too-large': return 'tooLarge'
    case 'invalid-document': case 'unsupported-format': return 'invalid'
    case 'timeout': return 'timeout'
    case 'unavailable': return 'unavailable'
    case 'busy': return 'busy'
    case 'source-changed': return 'changed'
    default: return 'failed'
  }
}
