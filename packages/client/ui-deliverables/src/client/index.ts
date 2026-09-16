/**
 * Deliverables plugin, browser half: registers the changed-files card and
 * delivery cards into the chat view's turn-tail chain, and provides the
 * `chatFileMentions` service that links inline-code mentions of produced or
 * delivered files in the closing prose. All policy lives here — the supported
 * mutation calls, mention matching, row cap, and copy — so composing this
 * plugin out of cordis.yml removes both surfaces entirely; the owning view
 * renders an empty chain and inert prose at zero cost.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import type { ChatFileMentions } from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { ChangesSummaryStore } from './changes-summary.ts'
import { PresentedOpenController } from './present-open.ts'
import { PresentRow } from './PresentRow.tsx'
import { Deliverables, selectDeliverables, type DeliverablesInjected } from './Deliverables.tsx'
import { en, NS, zh, type DeliverablesKey } from './locales.ts'
import {
  deliverablesDefinition, presentedForClosing, producedFileMentions, selectProducedFiles,
} from './turn-deliverables.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Changed-files card, delivery card, and file-mention copy. */
    'deliverables': DeliverablesKey
  }
}

/** Required services for the tail-slot registration and its dictionaries. */
export const inject = ['slots', 'locale', 'uiConversation', 'remote', 'remote.session']

/**
 * Client plugin body: register the dictionaries and the turn-tail entry.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const opener = new PresentedOpenController()
  const summaries = new ChangesSummaryStore()
  ctx.effect(() => () => Promise.all([opener.dispose(), summaries.dispose()]))
  ctx.on('connection/reset', () => {
    opener.resetHost()
    summaries.reset()
  })
  ctx.uiConversation.events.register(deliverablesDefinition)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-deliverables: dictionaries')
  ctx.slots.inject(
    'conversation.chat.turnTail',
    () => ctx.slots.register({
      name: 'conversation.chat.turnTail',
      select: selectDeliverables,
      locale: NS,
      inject: (): DeliverablesInjected => ({
        hooks: { presentedOpen: opener.state, presentedHost: opener.host, changesSummary: summaries.state },
        reloadPresentedHost: () => opener.loadHost(),
        loadChangesSummary: (sessionId, seq) => summaries.load(sessionId, seq),
        openPresented: (sessionId, seq, index, action) => opener.open(sessionId, seq, index, action),
        openChanged: (sessionId, seq, index) => opener.openChanged(sessionId, seq, index),
      }),
    }, Deliverables),
  )
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
    { name: 'tool.call.toolview', key: 'present', locale: NS }, PresentRow,
  ))
  // The prose side of the same vocabulary: the chat view reaches this face
  // via ctx.get, so its absence — this plugin composed out — is the off state.
  const t = ctx.locale.bind(NS)
  const mentions: ChatFileMentions = {
    forClosing(owner) {
      const paths = selectProducedFiles(owner)
      const presented = presentedForClosing(owner)
      if (paths === null && presented.length === 0) return undefined
      return producedFileMentions([...new Set([...paths ?? [], ...presented.map(file => file.path)])], owner.openFile,
        path => t('presented.previewButton', { name: path }))
    },
  }
  ctx.provide('chatFileMentions', mentions)
}
