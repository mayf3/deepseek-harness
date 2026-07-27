/**
 * Reference autocomplete domain contract.
 *
 * @module @deepseek-ai/dsh-host-apiproxy/api/references
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RpcRequest, RpcResponse } from './rpc.ts'

/** One file or directory candidate inside the target session workspace. */
export interface FileReferenceItem {
  path: string
  kind: 'file' | 'directory'
}

/** One metadata-only cross-session reference candidate. */
export interface SessionReferenceItem {
  sessionId: SessionId
  label: string
  cwd?: string
  createdAt: number
  /** Canonical opaque mention serialized into the prompt draft. */
  mention: string
}

/** Host-backed file and session reference discovery. */
export interface ReferencesApi {
  /** List path candidates using the target agent's workspace boundary. */
  files(
    request: RpcRequest<{ sessionId: SessionId; query: string }>,
    signal?: AbortSignal,
  ): Promise<RpcResponse<{ items: FileReferenceItem[] }>>

  /** List cross-session candidates excluding the target session itself. */
  sessions(
    request: RpcRequest<{ sessionId: SessionId; query: string }>,
    signal?: AbortSignal,
  ): Promise<RpcResponse<{ items: SessionReferenceItem[] }>>
}
