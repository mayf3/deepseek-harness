/**
 * Live-activity plugin, browser half: contributes one session-header action
 * that renders the activity roster and, per expanded row, an on-demand
 * observation stream's live output. All data arrives through the
 * `activityFeed` client service; this plugin holds no transport state.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { ActivityListAction } from './ActivityListAction.tsx'
import type { ActivityListInjected } from './ActivityListAction.tsx'
import type {} from '@deepseek-ai/dsh-api-activity-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { en, NS, zh, type ActivityKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Live-activity list copy. */
    'activity': ActivityKey
  }
}

export type { ActivityListActionProps, ActivityListInjected } from './ActivityListAction.tsx'

/** Required services: the activity feed, the slot registry, and dictionaries. */
export const inject = ['activityFeed', 'slots', 'locale']

/**
 * Client plugin body: register the dictionaries and the header action.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-activity: dictionaries')
  ctx.slots.inject(
    'conversation.session.header.actions',
    () => ctx.slots.register({
      name: 'conversation.session.header.actions',
      id: 'activity-list',
      // After the background-job list: job control reads before live output.
      order: 30,
      locale: NS,
      inject: (): ActivityListInjected => ({
        hooks: { activity: ctx.activityFeed.state },
        observe: id => ctx.activityFeed.observe(id),
      }),
    }, ActivityListAction),
  )
}
