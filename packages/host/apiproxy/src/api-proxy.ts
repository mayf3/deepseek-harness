/**
 * Host-side ApiProxy implementation. Signature discipline: unary takes the
 * narrow RpcRequest<P> and echoes request.rpcId on the RpcResponse<T>.
 */

import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import { canOpenNativePath } from '@deepseek-ai/dsh-native-command'
import type { ApiProxy } from './api/index.ts'
import {
  DEFAULT_SESSION_LOG_COMPRESSION_LEVEL,
  flushLiveSessionLog,
  sessionLogExportDeps,
  sessionLogZipFilename,
  streamSessionLogZip,
  type SessionLogExportReady,
  type SessionLogCompressionLevel,
} from './session-export.ts'
import type { SessionRawArtifact } from '@deepseek-ai/dsh-session-persistence'
import type { RpcRequest, RpcResponse } from './api/rpc.ts'

/** Wrap an ok result echoing the request's rpcId. */
function ok<T>(request: RpcRequest<unknown>, value: T): RpcResponse<T> {
  return { rpcId: request.rpcId, result: { ok: true, value } }
}

/** Deployment metadata and Host integrations consumed by the API implementation. */
export interface ApiProxyDefaults {
  /** Current deployment model selection reported by `host.describe`. */
  defaultModelSelection: () => ModelSelection
  /** Project hint reported by `host.describe`; must match Session Controller's default cwd. */
  cwd: string
  /** Validated DEFLATE level for session-log ZIP entries; defaults to 6. */
  sessionExportCompressionLevel?: SessionLogCompressionLevel
  /**
   * Whether handing a path to the native opener can work at all — the
   * `hasDocument` capability the preset roster reports, and the switch
   * between opening a preset directory and answering its path as text.
   * Absent, platform detection decides ({@link canOpenNativePath}).
   */
  canOpenPath?: () => boolean
}

/**
 * Implement ApiProxy over a composed host context.
 * @param ctx - a context with the Host spine mounted.
 * @param defaults - host routing and project-directory defaults.
 * @returns the ApiProxy implementation.
 */
export function createApiProxy(ctx: Context, defaults: ApiProxyDefaults): ApiProxy {
  const sessionExportCompressionLevel = defaults.sessionExportCompressionLevel
    ?? DEFAULT_SESSION_LOG_COMPRESSION_LEVEL
  /** Whether this deployment can hand a path to a native opener at all. */
  function canOpenPaths(): boolean {
    if (defaults.canOpenPath !== undefined) return defaults.canOpenPath()
    return canOpenNativePath()
  }

  return {
    host: {
      describe(request) {
        // TODO(apiproxy-version): read the version from apps/cli/package.json.
        const selection = defaults.defaultModelSelection()
        return Promise.resolve(ok(request, {
          version: '0.0.1',
          // This must match the default cwd supplied to Session Controller so
          // the UI's project hint names where a cwd-less create request lands.
          cwd: defaults.cwd,
          // Read live for the same reason: this is what the NEXT session will
          // start from, so a saved default has to be what it reports.
          provider: selection.provider,
          model: selection.model,
          attachedSessions: ctx.agents.list().length,
          home: homedir(),
          canOpenPath: canOpenPaths(),
        }))
      },

    },

    downloads: {
      async sessionLog(request, signal) {
        // Clean error path first: missing services answer 500 and a missing
        // root artifact 404 before any zip byte is produced. The root content
        // read here is reused as the first zip entry, so nothing is read twice.
        const deps = sessionLogExportDeps(ctx)
        if (deps.sessionQuery === undefined || deps.sessionPersistence === undefined || deps.attachments === undefined) {
          return new Response(
            'session log export is unavailable: missing session-query, session-persistence, or attachments service',
            { status: 500 },
          )
        }
        if (!deps.sessionPersistence.supportsRawArtifacts) {
          return new Response(
            'session log export is unavailable: the persistence backend does not expose per-session raw artifacts',
            { status: 501 },
          )
        }
        const ready: SessionLogExportReady = {
          sessionQuery: deps.sessionQuery,
          sessionPersistence: deps.sessionPersistence,
          attachments: deps.attachments,
          sessions: deps.sessions,
        }
        let root: SessionRawArtifact | undefined
        try {
          await flushLiveSessionLog(deps, request.sessionId, signal)
          root = await deps.sessionPersistence.readRaw(request.sessionId, signal)
          signal.throwIfAborted()
        } catch {
          signal.throwIfAborted()
          // Root preparation failure: answer 500 without echoing the error,
          // which may carry absolute host paths into the browser error bar.
          return new Response('session log export failed to prepare the stored artifact', { status: 500 })
        }
        if (root === undefined) {
          return new Response('session not found', { status: 404 })
        }
        return new Response(
          streamSessionLogZip(
            ready,
            root,
            request.sessionId,
            request.includeDescendants === true,
            sessionExportCompressionLevel,
            signal,
          ),
          {
            headers: {
              'content-type': 'application/zip',
              'content-disposition': `attachment; filename="${sessionLogZipFilename(request.sessionId)}"`,
            },
          },
        )
      },
    },
  }
}
