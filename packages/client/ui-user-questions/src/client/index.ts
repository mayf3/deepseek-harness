/**
 * Web question plugin, browser half: QuestionComposer registered as a
 * selector-routed entry of the conversation-declared composer chain, plus the
 * `question` dictionaries. The selector narrows the owner's currency to the
 * question carrier (matched prop), and the whole behavior surface rides the
 * carrier (domain encoding in contract/slots.ts PendingQuestion); copy rides
 * the standard locale seat. Export discipline: packages/client/AGENTS.md.
 *
 * One entry, two shapes: the composer renders a request that declares a
 * presentation intent as that intent's own surface (`plan-review` → the plan
 * decision card) and every other request as the generic question flow. A
 * separate chain entry per shape would race the same carrier, so the shape
 * choice lives inside this entry — see QuestionComposer.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { PendingWait } from '@deepseek-ai/dsh-client-runtime/client'
import type { ComposerChainProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { planReviewOf, type QuestionWait } from './contract/slots.ts'
import { QuestionComposer } from './QuestionComposer.tsx'
import { en, zh, type QuestionKey } from './locales.ts'

export { PendingQuestion } from './contract/slots.ts'
export type {
  PlanReview, QuestionAnswer, QuestionComposerProps, QuestionWait,
} from './contract/slots.ts'
export type { QuestionKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The question composer's copy. */
    question: QuestionKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'question'

/** Required services: the slot registry and the question composer's copy. */
export const inject = ['slots', 'sessions', 'remote', 'conversation', 'locale']

/** Chain routing: claim the composer while a question wait is pending (pure — owner props only). */
function selectQuestion({ pendingInteraction }: ComposerChainProps): QuestionWait | null {
  return pendingInteraction?.kind === 'question' ? pendingInteraction : null
}

/**
 * Client plugin body: register the `question` dictionaries and the question
 * composer into the composer chain. Zero business face — data and verbs live
 * on the matched carrier; t rides the standard locale seat.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-user-questions: dictionaries')

  ctx.slots.inject('conversation.composer', () => ctx.slots.register(
    { name: 'conversation.composer', select: selectQuestion, locale: NS },
    QuestionComposer,
  ))

  let nextQuestionKey = 0
  ctx.remote.$on('user-questions/request', function (request, next) {
    const sessionId = ctx.sessions.scopeOf(this)
    if (sessionId === undefined) return next()
    nextQuestionKey += 1
    const interactionId = `remote-${String(nextQuestionKey)}`
    const completion = Promise.withResolvers<Awaited<ReturnType<typeof next>>>()
    const wait = new PendingWait('question', interactionId, sessionId, {
      questions: request.questions,
    }, (response) => {
      if (response.result.ok) {
        completion.resolve(response.result.value.answer)
      } else {
        const error = new Error(response.result.error.message) as Error & { code: string }
        error.name = 'UserQuestionError'
        error.code = response.result.error.code === 'cancelled'
          ? 'ASK_CANCELLED'
          : response.result.error.code
        completion.reject(error)
      }
      return Promise.resolve({ ok: true, value: { accepted: true } })
    })
    const status = planReviewOf(request.questions) === undefined ? 'question' : 'plan-review'
    const remove = ctx.conversation.pendingInteractions.present(
      wait,
      status,
      status === 'plan-review' ? 2 : 1,
    )
    const signal = request.signal
    if (signal === undefined) return completion.promise.finally(remove)
    const abort = (): void => {
      completion.reject(signal.reason)
    }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    return completion.promise.finally(() => {
      signal.removeEventListener('abort', abort)
      remove()
    })
  })
}
