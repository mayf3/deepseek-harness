/** Client Cordis plugin that publishes browser observations directly to the Inspector Worker. */

import type { Context } from '@deepseek-ai/cordis'
import { parseInspectorClientBootstrap } from '../shared/bridge/control-codec.ts'
import { createInspectorService, type InspectorService as SharedInspectorService } from '../shared/service.ts'
import { publishCordisTree } from './inspection/cordis.ts'
import { startInspectorClient } from './bridge/controller.ts'

export type { CordisRuntimeTreeReader } from '../shared/cordis/reader.ts'
export type {
  CordisRuntimeConnection,
  CordisRuntimeContext,
  CordisRuntimeFiber,
  CordisRuntimeNode,
  CordisRuntimeRealm,
  CordisRuntimeSource,
  CordisRuntimeTree,
} from '../shared/cordis/model.ts'

/** Client-facing Inspector service backed by the shared implementation. */
export interface InspectorService extends SharedInspectorService {}

declare global {
  /** Host-injected Inspector Client connection parameters. */
  var __DSH_INSPECTOR__: unknown
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Publish Client-realm observations and query the shared Inspector state. */
    inspector: InspectorService
  }
}

/** Cordis plugin name shared with the Host face. */
export const name = 'experimental-inspector'

/** This transport root has no Client service dependencies. */
export const inject: string[] = []

/** Mount the Client source and shared `ctx.inspector` publishing API. */
export function apply(ctx: Context): void {
  const injected = globalThis.__DSH_INSPECTOR__
  if (injected === undefined) {
    throw new Error('experimental inspector: Host bootstrap is missing')
  }
  const bootstrap = parseInspectorClientBootstrap(injected)
  ctx.effect(() => {
    const source = startInspectorClient(bootstrap)
    const disposeCordis = publishCordisTree(ctx, source, {
      maxNodes: bootstrap.maxCordisNodes,
      maxBytes: bootstrap.maxFrameBytes - 4_096,
    })
    const disposeService = ctx.provide('inspector', createInspectorService(source))
    return () => {
      disposeService()
      disposeCordis()
      source.close()
    }
  }, 'experimental-inspector: Client source')
}
