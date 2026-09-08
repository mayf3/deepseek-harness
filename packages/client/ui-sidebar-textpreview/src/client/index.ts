/**
 * Browser half: register `text` as a right-Sidebar tab type.
 *
 * The type reaches the Sidebar through its public path only: the definition into
 * `ctx.sidebarRightTabs` and the body into the keyed `sidebar.right.pane.tab`
 * seat under the definition's `id`. Nothing here reaches into the Sidebar's store, its
 * panes, or its sequence. The file's metadata comes from the standard
 * `useResource`, served by the `file` provider; the content is this type's own
 * business, read through its face. Every import from another
 * client plugin is a type.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-resources/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-api-workspace-files/remote'
import type { WorkspaceFileParams } from '@deepseek-ai/dsh-api-workspace-files/client'
import { TextPreview } from './TextPreview.tsx'
import type { TextPreviewInjected } from './TextPreview.tsx'
import { TEXTPREVIEW_ID, textDefinition } from './definition.ts'
import { textFace } from './face.ts'
import { createReadPage } from './rpc.ts'
import { createTextStore } from './store.ts'
import { en, zh } from './locales.ts'
import { DocumentPreviewRegistry } from './document/registry.ts'
import { documentTabInfoFactory } from './document/contract.ts'
import { apply as registerText } from './text/index.ts'
import { apply as registerMarkdown } from './markdown/index.ts'
import { apply as registerHtml } from './html/index.ts'
import { apply as registerPdf } from './pdf/index.ts'
import { apply as registerCode } from './code/index.ts'

// Values stay package-private unless another package needs them; the plugin
// surface is `apply`, `inject`, and the store factory another registration may
// share, plus the types a consumer of the seat or the store names.
export type { SidebarTextpreviewKey } from './locales.ts'
export type { TextPreviewProps } from './TextPreview.tsx'
export type { TextInjected } from './face.ts'
export type { ReadWorkspaceFilePage, SessionFile, WorkspaceFilesReadRemote } from './rpc.ts'
export type { TextPage, TextState, TextStore, TextTabState } from './store.ts'
export type { DocumentContent, DocumentPreviewProps, DocumentTextPage } from './document/contract.ts'
export type { DocumentLoadMode, DocumentPreviewDefinition } from './document/registry.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** File-extension renderer registrations, independent from their keyed document bodies. */
    documentPreviews: DocumentPreviewRegistry
  }
}

/** This package's copy namespace. */
const NS = 'sidebarTextpreview'

declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightResourceParamsMap {
    /** File line navigation supported by the text preview. */
    file: WorkspaceFileParams
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Text-preview progress, paging, change, control, and failure lines. */
    sidebarTextpreview: import('./locales.ts').SidebarTextpreviewKey
  }
}

/**
 * Required browser services: the tab registry, the slot registry, copy, and the
 * Remote carrier with its `workspaceFiles` namespace.
 */
export const inject = ['slots', 'locale', 'sidebarRightTabs', 'remote', 'remote.workspaceFiles']

/** Bounds on HTML's statically referenced local resources. */
export interface Config {
  /** Maximum decoded bytes per referenced resource. */
  htmlMaxAssetBytes: number
  /** Maximum decoded bytes across the HTML and referenced resources. */
  htmlMaxTotalBytes: number
  /** Maximum distinct referenced scripts and stylesheets. */
  htmlMaxAssets: number
}

/** Validated limits for static HTML dependency loading. */
export const Config: z<Partial<Config>, Config> = z.object({
  htmlMaxAssetBytes: z.natural().min(1).default(4 * 1024 * 1024),
  htmlMaxTotalBytes: z.natural().min(1).default(32 * 1024 * 1024),
  htmlMaxAssets: z.natural().min(1).default(64),
})

/**
 * Client plugin body: register the type, its dictionaries, and its body.
 * @param ctx - client root context carrying the registry, the slots, copy, and the Remote face.
 * @param config - validated local-resource limits.
 */
export function apply(ctx: ClientContext, config: Config = Config({})): void {
  const previews = new DocumentPreviewRegistry()
  const disposePreviews = ctx.reflect.provide('documentPreviews', previews)
  ctx.effect(() => disposePreviews)
  ctx.effect(() => ctx.sidebarRightTabs.register(textDefinition()), 'ui-sidebar-textpreview: text type')
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-sidebar-textpreview: dictionaries')

  const store = createTextStore()
  const face = textFace(
    createReadPage(ctx.remote),
    (file, signal) => ctx.remote.workspaceFiles.readAll(file.sessionId, file.path, signal),
  )
  const source = { getSnapshot: previews.getSnapshot, subscribe: previews.subscribe }
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    {
      name: 'sidebar.right.pane.tab', key: TEXTPREVIEW_ID, locale: NS, store,
      children: {
        'sidebar.right.tab.document': { kind: 'keyed', scope: 'session', inject: { hooks: { tabInfo: documentTabInfoFactory } } },
      },
      inject: (sessionId, actions): TextPreviewInjected => ({ ...face(sessionId, actions), hooks: { documentPreviews: source } }),
    },
    TextPreview,
  )), 'ui-sidebar-textpreview: text body')
  registerText(ctx)
  registerMarkdown(ctx)
  registerHtml(ctx, { maxAssetBytes: config.htmlMaxAssetBytes, maxTotalBytes: config.htmlMaxTotalBytes, maxAssets: config.htmlMaxAssets })
  registerPdf(ctx)
  registerCode(ctx)
}
