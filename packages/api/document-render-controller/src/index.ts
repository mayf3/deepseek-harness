/** Session-authorized Office preview Remote; source bytes never travel to the browser. */
import { extname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { WorkspaceFileScope, WorkspaceFileStat } from '@deepseek-ai/dsh-api-workspace-files'
import { brandString } from '@deepseek-ai/dsh-brand'
import { OfficeToPdfError, type OfficeSourceKey, type OfficeToPdfPriority, type OfficeToPdfGeneration } from '@deepseek-ai/dsh-office-to-pdf'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { RenderedDocumentBytes } from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Client-only Office preview over authorized workspace-file reads. */
    documentRenderController: DocumentRenderController
  }
}

/** Converts authorized bytes without activating an Agent or appending Session events. */
export class DocumentRenderController extends TypertRemoteService {
  static inject = ['workspaceFiles', 'officeToPdf']
  private readonly lifetime = new AbortController()
  private readonly active = new Set<Promise<RenderedDocumentBytes>>()

  constructor(ctx: Context) {
    super(ctx, 'documentRenderController', { namespace: 'documentRender' })
    ctx.effect(() => async () => { this.lifetime.abort(); await Promise.allSettled(this.active) })
  }

  /**
   * Read and convert one Office file using the Session's ordinary filesystem authorization.
   * @param workspaceFileScope - Session header lookup shared with workspaceFiles.
   * @param path - absolute or workspace-relative Office path.
   * @param priority - foreground preview or speculative background work.
   * @param signal - Remote cancellation; disposal also cancels outstanding reads and conversions.
   * @returns complete base64 PDF with original source identity and missing font families.
   */
  @Remote
  async render(
    workspaceFileScope: WorkspaceFileScope, path: string, priority: OfficeToPdfPriority, signal: AbortSignal,
  ): Promise<RenderedDocumentBytes> {
    const upstream = AbortSignal.any([signal, this.lifetime.signal])
    const operation = this.convert(workspaceFileScope, path, priority, upstream)
    this.active.add(operation)
    try { return await operation } finally { this.active.delete(operation) }
  }

  /**
   * Read the current rendering generation before reusing a Client PDF.
   * @param signal - Remote caller cancellation.
   * @returns provider lifetime, replaced with rendering, font, or engine configuration.
   */
  @Remote
  generation(signal: AbortSignal): OfficeToPdfGeneration { signal.throwIfAborted(); return this.ctx.officeToPdf.generation }

  private async convert(
    scope: WorkspaceFileScope, path: string, priority: OfficeToPdfPriority, signal: AbortSignal,
  ): Promise<RenderedDocumentBytes> {
    try {
      signal.throwIfAborted()
      const extension = extname(path).slice(1).toLowerCase()
      if (extension !== 'doc' && extension !== 'docx' && extension !== 'xls'
        && extension !== 'xlsx' && extension !== 'ppt' && extension !== 'pptx') {
        throw new OfficeToPdfError('unsupported-format', 'The path must end in doc, docx, xls, xlsx, ppt, or pptx.')
      }
      const authorized = await this.ctx.workspaceFiles.readBytes(scope, path, { offset: 0, length: 1 }, signal)
      const source = await this.ctx.workspaceFiles.stat(scope, path, signal)
      const assertUnchanged = (current: WorkspaceFileStat): void => {
        if (current.absolutePath !== source.absolutePath || current.version !== source.version) {
          throw new OfficeToPdfError('source-changed', 'The source changed.')
        }
      }
      assertUnchanged(authorized)
      signal.throwIfAborted()
      const result = await this.ctx.officeToPdf.convert({ extension, priority, source: {
        key: brandString<OfficeSourceKey>(JSON.stringify([scope.sessionId, scope.workspaceRoot, source.absolutePath])),
        version: source.version, ...(source.bytes === undefined ? {} : { bytes: source.bytes }),
        read: async (upstream, maxBytes) => {
          const loaded = await this.ctx.workspaceFiles.readAllBounded(scope, path, maxBytes, upstream).catch(async (cause: unknown) => {
            if (cause instanceof RemoteError && cause.code === 'workspace-file/too-large') {
              assertUnchanged(await this.ctx.workspaceFiles.stat(scope, path, upstream))
            }
            throw cause
          })
          upstream.throwIfAborted()
          const after = await this.ctx.workspaceFiles.stat(scope, path, upstream)
          assertUnchanged(loaded)
          assertUnchanged(after)
          return { bytes: loaded.data, version: loaded.version }
        },
      } }, signal)
      signal.throwIfAborted()
      return { absolutePath: source.absolutePath, version: source.version,
        offset: 0, eof: true, bytes: result.pdf.byteLength, data: Buffer.from(result.pdf).toString('base64'), missingFonts: result.missingFonts, generation: result.generation }
    } catch (cause) {
      if (signal.aborted) throw new RemoteError('gateway/cancelled', 'The document preview was cancelled.', {}, { cause })
      if (cause instanceof OfficeToPdfError) {
        throw new RemoteError('document-render/failed', 'Office conversion failed.', { reason: cause.code }, { cause })
      }
      throw cause
    }
  }
}

export default DocumentRenderController
