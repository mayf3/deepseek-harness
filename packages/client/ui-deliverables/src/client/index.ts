/**
 * Deliverables plugin, browser half: registers the changed-files card and
 * delivery cards into the chat view's turn-tail chain, the `changes-diff`
 * right-Sidebar tab type that shows one listed file's turn-start and turn-end
 * comparison, and provides the `chatFileMentions` service that links
 * inline-code mentions of produced or delivered files in the closing prose.
 * All policy lives here — the supported mutation calls, mention matching, row
 * cap, and copy — so composing this plugin out of cordis.yml removes every
 * surface; the owning view renders an empty chain and inert prose at zero cost.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import type { ChatFileMentions } from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { changesDiffAddress } from '../changes.ts'
import { ChangesDiffStore } from './changes-diff.ts'
import { ChangesSummaryStore } from './changes-summary.ts'
import { PresentedOpenController } from './present-open.ts'
import { PresentRow } from './PresentRow.tsx'
import { Deliverables, selectDeliverables, type DeliverablesInjected } from './Deliverables.tsx'
import { DiffPreview, type DiffPreviewInjected } from './DiffPreview.tsx'
import { CHANGES_DIFF_ID, changesDiffDefinition } from './diff-definition.ts'
import { en, NS, zh, type DeliverablesKey } from './locales.ts'
import {
  deliverablesDefinition, presentedForClosing, producedFileMentions, selectProducedFiles,
} from './turn-deliverables.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Changed-files card, comparison tab, delivery card, and file-mention copy. */
    'deliverables': DeliverablesKey
  }
}

/** Required services for the tail-slot and tab-type registrations and their dictionaries. */
export const inject = ['slots', 'locale', 'uiConversation', 'remote', 'remote.session', 'sidebarRightTabs', 'sidebarRight']

/**
 * Client plugin body: register the dictionaries, the turn-tail entry, and the comparison tab type.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const opener = new PresentedOpenController()
  const summaries = new ChangesSummaryStore()
  const diffs = new ChangesDiffStore()
  ctx.effect(() => () => Promise.all([opener.dispose(), summaries.dispose(), diffs.dispose()]))
  ctx.on('connection/reset', () => {
    opener.resetHost()
    summaries.reset()
    diffs.reset()
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
        openChangesDiff: (coordinates) => { ctx.sidebarRight.openResource(changesDiffAddress(coordinates)) },
      }),
    }, Deliverables),
  )
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
    { name: 'tool.call.toolview', key: 'present', locale: NS }, PresentRow,
  ))
  ctx.effect(() => ctx.sidebarRightTabs.register(changesDiffDefinition()), 'ui-deliverables: changes-diff type')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    {
      name: 'sidebar.right.pane.tab', key: CHANGES_DIFF_ID, locale: NS,
      inject: (): DiffPreviewInjected => ({
        hooks: { changesDiff: diffs.state, presentedOpen: opener.state, presentedHost: opener.host },
        loadChangesDiff: (sessionId, seq, index) => diffs.load(sessionId, seq, index),
        reloadPresentedHost: () => opener.loadHost(),
        openChanged: (sessionId, seq, index) => opener.openChanged(sessionId, seq, index),
      }),
    },
    DiffPreview,
  )), 'ui-deliverables: changes-diff body')
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
