import type { Context } from '@deepseek-ai/cordis'
import type {
  ConversationNodeDefinition, RequestPromptInspector, SystemPromptNode,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { trajectoryNode } from './trajectory-definition-common.ts'
import type { TrajectoryRequestHeaderState } from './trajectory-contract.ts'

/** A retained system node plus, for an in-history update, the request facts it changes. */
export interface TrajectorySystemMessageState extends SystemPromptNode {
  /**
   * Present for an update that follows a loaded request header: that header's
   * prompt with this node's text, so later requests in the ledger show the
   * prompt the model read and the first of them carries the change.
   */
  readonly header?: TrajectoryRequestHeaderState
}

/* jscpd:ignore-start -- Target-owned Definitions intentionally keep their event
 * state machines independent; see ../../../../../.agents/notes/implemented/
 * architecture/2026-08-09-client-conversation-node-assembly.md. */
/**
 * Definition retaining each `system/message` surface node for the Trajectory
 * request-header Definition, which reads it through `reader.previous` and
 * presents the prompt through the request's `system` cell. A node that
 * introduces or replaces the prompt contributes nothing itself; an in-history
 * update contributes a request-header fact at its own position, since no
 * `request/header` follows a prompt change that keeps the cached history.
 */
export const trajectorySystemMessageDefinition: ConversationNodeDefinition<TrajectorySystemMessageState> = {
  kind: 'trajectory-system-message',
  target: 'trajectory',
  match: event => event.type === 'system/message'
    ? { id: String(event.seq), role: 'start' }
    : null,
  start: (_context, match, reader) => {
    if (match.event.type !== 'system/message') {
      throw new Error('trajectory-system-message start requires system/message')
    }
    const node: SystemPromptNode = {
      seq: match.event.seq,
      time: match.event.time,
      turn: match.event.data.turn,
      step: match.event.data.step,
      text: match.event.data.message.content
        .flatMap(block => block.type === 'text' ? [block.text] : [])
        .join(''),
      update: match.event.surfaceOp === 'append'
        && reader.previous<TrajectorySystemMessageState>('trajectory-system-message') !== undefined,
    }
    const previous = node.update
      ? reader.previous<TrajectoryRequestHeaderState>('trajectory-request-header')?.state
      : undefined
    if (previous === undefined) return node
    return {
      ...node,
      header: {
        seq: node.seq,
        time: node.time,
        prompt: { ...previous.prompt, system: node.text },
        change: { seq: node.seq, time: node.time, kind: 'system', previous: previous.prompt },
        location: match.location,
      },
    }
  },
  update: context => context.state,
  buildViewNode: context => context.state?.header === undefined
    ? null
    : trajectoryNode(context, context.state.seq, {
      kind: 'request-header',
      header: context.state.header,
    }),
}
/* jscpd:ignore-end */

/**
 * Request-header fact Definition for the Trajectory target.
 * @param inspect - the shared prompt interpretation, supplied by the
 * uiConversation service (a client bundle cannot value-import it).
 * @returns the Trajectory request-header Definition.
 */
function trajectoryRequestHeaderDefinition(inspect: RequestPromptInspector): ConversationNodeDefinition<TrajectoryRequestHeaderState> {
  return {
    kind: 'trajectory-request-header',
    target: 'trajectory',
    match: event => event.type === 'request/header'
      ? { id: String(event.seq), role: 'start' }
      : null,
    start: (_context, match, reader) => {
      if (match.event.type !== 'request/header') {
        throw new Error('trajectory-request-header start requires request/header')
      }
      const previous = reader.previous<TrajectoryRequestHeaderState>('trajectory-request-header')
        ?.state.prompt
      const system = reader.previous<SystemPromptNode>(trajectorySystemMessageDefinition.kind)?.state
      const { prompt, change } = inspect(previous, match.event, system)
      return {
        seq: match.event.seq,
        time: match.event.time,
        prompt,
        location: match.location,
        ...(change === undefined ? {} : { change }),
      }
    },
    update: context => context.state,
    buildViewNode: context => context.state === undefined
      ? null
      : trajectoryNode(context, context.state.seq, {
        kind: 'request-header',
        header: context.state,
      }),
  }
}

/**
 * Register Trajectory system-prompt node and request-header facts.
 *
 * @param ctx - Plugin context receiving the Definitions.
 */
export function registerTrajectoryRequestHeaderDefinition(ctx: Context): void {
  ctx.uiConversation.events.register(trajectorySystemMessageDefinition)
  ctx.uiConversation.events.register(trajectoryRequestHeaderDefinition(
    (previous, event, system) => ctx.uiConversation.inspectRequestPrompt(previous, event, system),
  ))
}
