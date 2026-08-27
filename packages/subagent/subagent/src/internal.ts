/**
 * Host-only continuation adapters outside the public Service Definition and
 * model-facing Agent messaging contract.
 * @module @deepseek-ai/dsh-subagent/internal
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, MessageId, MessageSource } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type SubagentRuntime from './index.ts'

/**
 * Process-stable symbol-keyed Queue delivery shared by the bundled runtime
 * entry and this unbundled internal subpath.
 * @internal
 */
export const queueSubagentPrompt = Symbol.for('dsh.subagent.queuePrompt')

/** Runtime face required by the host-only Queue adapter. */
export interface HostPromptQueue {
  [queueSubagentPrompt](
    parent: Agent,
    childId: SessionId,
    content: ContentBlock[],
    source: MessageSource,
    signal: AbortSignal,
  ): Promise<MessageId>
}

/**
 * Queue one host-protocol message without exposing another Service operation.
 * @param runtime - subagent runtime owning continuation residency.
 * @param parent - exact live direct parent authorizing delivery.
 * @param childId - durable direct-child session id.
 * @param content - host-authored content to deliver.
 * @param source - durable host-protocol provenance.
 * @param signal - caller cancellation before inbox acceptance.
 * @returns the accepted message's inbox id.
 */
export function queueHostSubagentPrompt(
  runtime: SubagentRuntime,
  parent: Agent,
  childId: SessionId,
  content: ContentBlock[],
  source: MessageSource,
  signal: AbortSignal,
): Promise<MessageId> {
  return (runtime as unknown as HostPromptQueue)[queueSubagentPrompt](
    parent,
    childId,
    content,
    source,
    signal,
  )
}
