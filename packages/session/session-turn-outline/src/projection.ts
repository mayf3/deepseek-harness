/**
 * The `turnOutline` projection unit: a pure fold of `turn/start` boundaries
 * and first human prompts into the whole-log turn outline the chat rail
 * renders for turns outside a client's paged event window.
 *
 * `turn/start` — not the prompt `user/message` — anchors each entry because
 * its seq is the load-through target for a jump: the loop logs `turn/start`
 * before the turn's prompt and steps, so a window paged back through that seq
 * contains the whole turn. The preview mirrors the rail's loaded-turn preview
 * (space-joined text blocks, collapsed whitespace, 160-character cap) so a
 * turn shows the same words before and after its events load.
 *
 * @module @deepseek-ai/dsh-session-turn-outline/projection
 */

import { z } from 'zod'
import type { ZodType } from 'zod'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { TurnOutlineProjection } from './types.ts'

/** Preview budget per entry, matching the rail's loaded-turn preview clamp. */
const PREVIEW_LIMIT = 160

/** Space-join text blocks until the budget is met, then normalize and cap. */
function promptPreview(content: SessionEvent<'user/message'>['data']['content']): string {
  let text = ''
  for (const block of content) {
    if (block.type !== 'text') continue
    text += text === '' ? block.text : ` ${block.text}`
    if (text.length >= PREVIEW_LIMIT) break
  }
  return text.replace(/\s+/g, ' ').trim().slice(0, PREVIEW_LIMIT)
}

const turnOutlineSchema: ZodType<TurnOutlineProjection> = z.object({
  turns: z.array(z.object({
    turn: z.number().int().nonnegative(),
    seq: z.number().int().nonnegative(),
    prompt: z.string().max(PREVIEW_LIMIT),
  }).strict()),
}).strict().superRefine((state, context) => {
  let previous = -1
  for (const entry of state.turns) {
    if (entry.turn <= previous) {
      context.addIssue({ code: 'custom', message: 'turn outline entries must be strictly increasing by turn' })
      return
    }
    previous = entry.turn
  }
})

const EMPTY_OUTLINE: TurnOutlineProjection = { turns: [] }

/** The `turnOutline` unit registered on `ctx.sessionProjections` (exported for the unit spec). */
export const turnOutlineProjectionDefinition = {
  key: 'turnOutline',
  stateVersion: 1,
  stateSchema: turnOutlineSchema,
  init: () => EMPTY_OUTLINE,
  apply: (state, event) => {
    // Every uninteresting event returns the same reference (Object.is gates the change feed).
    switch (event.type) {
      case 'turn/start': {
        const last = state.turns.at(-1)
        // Order guard: a boundary that does not advance the turn number keeps
        // the outline sorted, and a retried turn's prompt lands on the
        // standing entry.
        if (last !== undefined && event.data.turn <= last.turn) return state
        return { turns: [...state.turns, { turn: event.data.turn, seq: event.seq, prompt: '' }] }
      }
      case 'user/message': {
        // Only the newest turn can still be waiting for its opening human
        // prompt; later human messages in the same turn (steering) keep the
        // first preview.
        if (event.data.source.kind !== 'user') return state
        const last = state.turns.at(-1)
        if (last === undefined || last.prompt !== '') return state
        const prompt = promptPreview(event.data.content)
        if (prompt === '') return state
        return { turns: [...state.turns.slice(0, -1), { ...last, prompt }] }
      }
      default:
        return state
    }
  },
  wire: {
    viewSchema: turnOutlineSchema,
    view: state => state,
  },
} satisfies ProjectionDefinition<'turnOutline', TurnOutlineProjection>
