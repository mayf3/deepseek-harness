/** Deterministic provider for model-visible foreground and Job diagnostic snapshots. */

import type { Context } from '@deepseek-ai/cordis'
import {
  NO_START_CAPABILITIES,
  type ResolvedSubagentStartRequest,
  type SubagentProvider,
} from '@deepseek-ai/dsh-subagent'
import { SessionId } from '@deepseek-ai/dsh-session'

export const name = 'subagent-result-diagnostic'
export const inject = ['subagents']

const DIAGNOSTIC = 'Claude Code unattended decision (mode: dontAsk; request: tool permission; decision: denied): Claude Code denied the request before an interactive prompt'

class DiagnosticProvider implements SubagentProvider {
  readonly name = 'snapshot-diagnostic'
  readonly capabilities = NO_START_CAPABILITIES
  readonly inheritsParentContext = false
  private starts = 0

  async start(request: ResolvedSubagentStartRequest) {
    if (request.signal.aborted) {
      throw new Error('snapshot diagnostic provider start aborted')
    }
    const index = this.starts++
    if (index > 1) {
      throw new Error('snapshot diagnostic provider expected exactly two starts')
    }
    return {
      id: SessionId(index === 0
        ? '00000000-0000-4000-8000-0000000000d1'
        : '00000000-0000-4000-8000-0000000000d2'),
      localAgent: undefined,
      result: Promise.resolve({
        output: index === 0
          ? [{ type: 'text' as const, text: 'partial assistant text' }]
          : [],
        diagnostic: DIAGNOSTIC,
        stopReason: 'error' as const,
      }),
      dispose: async () => {},
    }
  }
}

/** Register the fixed provider behind the public Codex-shaped snapshot tool. */
export function apply(ctx: Context): void {
  ctx.subagents.registerProvider(new DiagnosticProvider())
}
