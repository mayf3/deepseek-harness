/**
 * Durable projection state for the two loop-owned surface messages the system
 * prompt plugin forms: the system prompt (surface node 0) and the dynamic
 * runtime-context snapshot.
 * @module @deepseek-ai/dsh-agent-loop/runtime-context
 */

import { createSystemMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextSnapshotSection, Message } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionSeq, SurfaceIntent, SystemMessage, UserMessage } from '@deepseek-ai/dsh-session'
import { isReplacementSurfaceEvent } from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'

const SOURCE = '@deepseek-ai/dsh-system-prompt'
const CLEARED = 'Current runtime context: none. Earlier runtime-context snapshots no longer apply.'

function isOwned(message: UserMessage): boolean {
  return message.source.kind === 'plugin' && message.source.plugin === SOURCE
}

function textOf(message: Message): string | undefined {
  const [block] = message.content
  return message.content.length === 1 && block?.type === 'text' ? block.text : undefined
}

/** One uncommitted system-prompt surface operation the loop commits before the step's user messages. */
export interface SystemPromptCommit {
  /** The rendered prompt as a system-role message; empty content records "no system prompt". */
  message: SystemMessage
  /** `append` for the session's first system node, otherwise a replacement of the retained node. */
  intent: SurfaceIntent
}

/** Committed events from the newest backward; the restore scans stop at the first match. */
function eventsNewestFirst(session: Session): readonly SessionEvent[] {
  return session.snapshotEvents().toReversed()
}

/**
 * Tracks the retained `system/message` surface node without owning its commit.
 * The first rendered prompt, even empty, reserves surface node 0; every later change
 * replaces the retained node in place, so the model-visible head of the
 * request is derived history like every other message.
 */
export class SystemPromptProjection {
  /** The surviving system node, or `undefined` when the surface has none. */
  private retained: { seq: SessionSeq; text: string } | undefined

  /**
   * Restore projection state once, then follow authoritative session events.
   * @param ctx - agent-scoped event context.
   * @param session - session receiving projected messages.
   */
  constructor(ctx: Context, session: Session) {
    const surface = new Set(session.surface.nodes)
    for (const event of eventsNewestFirst(session)) {
      if (event.type !== 'system/message' || !surface.has(event.seq)) continue
      this.retained = { seq: event.seq, text: textOf(event.data.message) ?? '' }
      break
    }

    ctx.on('session/event', (subject, event) => {
      if (subject !== session) return
      if (event.type === 'system/message') {
        this.retained = { seq: event.seq, text: textOf(event.data.message) ?? '' }
      } else if (this.retained
        && isReplacementSurfaceEvent(event)
        && event.sourceEventSeqs?.includes(this.retained.seq) === true) {
        this.retained = undefined
      }
    })
  }

  /**
   * Create an uncommitted system node when absent, even for an empty prompt, or changed.
   * @param rendered - the fully rendered system prompt; `''` when none is active.
   * @returns the message and its surface intent, or `undefined` when no update is needed.
   */
  project(rendered: string): SystemPromptCommit | undefined {
    if (this.retained === undefined) {
      return { message: createSystemMessage(rendered, SOURCE), intent: { surfaceOp: 'append' } }
    }
    if (this.retained.text === rendered) return
    const { seq } = this.retained
    return {
      message: createSystemMessage(rendered, SOURCE),
      intent: { surfaceOp: { op: 'replace', start: seq, end: seq }, sourceEventSeqs: [seq] },
    }
  }
}

/** Tracks the last retained runtime-context snapshot without owning its commit. */
export class RuntimeContextProjection {
  /** `undefined` means no snapshot ever existed; `null` means none is retained. */
  private retained: { seq: SessionSeq; text: string | undefined } | null | undefined

  /**
   * Restore projection state once, then follow authoritative session events.
   * @param ctx - agent-scoped event context.
   * @param session - session receiving projected messages.
   */
  constructor(ctx: Context, session: Session) {
    const surface = new Set(session.surface.nodes)
    for (const event of eventsNewestFirst(session)) {
      if (event.type !== 'user/message' || !isOwned(event.data)) continue
      this.retained ??= null
      if (surface.has(event.seq)) {
        this.retained = { seq: event.seq, text: textOf(event.data) }
        break
      }
    }

    ctx.on('session/event', (subject, event) => {
      if (subject !== session) return
      if (event.type === 'user/message' && isOwned(event.data)) {
        this.retained = { seq: event.seq, text: textOf(event.data) }
      } else if (this.retained
        && isReplacementSurfaceEvent(event)
        && event.sourceEventSeqs?.includes(this.retained.seq) === true) {
        this.retained = null
      }
    })
  }

  /**
   * Create an uncommitted snapshot only when the retained value differs.
   * @param current - fully rendered dynamic context.
   * @param sections - named contributions that formed the current snapshot.
   * @returns a candidate user message, or `undefined` when no update is needed.
   */
  project(current: string, sections: readonly ContextSnapshotSection[]): UserMessage | undefined {
    if (this.retained === undefined && current.length === 0) return
    const snapshot = current.length === 0 ? CLEARED : current
    if (this.retained?.text === snapshot) return
    return createUserMessage({
      content: [{ type: 'text', text: snapshot }],
      // The cleared marker has no contributions left to attribute.
      source: sections.length === 0
        ? { kind: 'plugin', plugin: SOURCE }
        : { kind: 'plugin', plugin: SOURCE, form: 'snapshot', sections },
    })
  }
}
