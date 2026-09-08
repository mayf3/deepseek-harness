/** Restorable PDF viewing preferences; document objects and canvases remain component-local. */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'

/** One tab's page selection and zoom factor. */
export interface PdfView {
  readonly page: number
  readonly zoom: number
}

/** Initial viewing preferences before a tab changes page or zoom. */
export const DEFAULT_PDF_VIEW: PdfView = { page: 1, zoom: 1 }

/** Page and zoom state isolated by the owning tab record. */
export interface PdfState {
  byTab: Record<TabId, PdfView>
}

type PdfActions = {
  page: (draft: PdfState, tabId: TabId, page: number) => void
  zoom: (draft: PdfState, tabId: TabId, zoom: number) => void
  forget: (draft: PdfState, tabId: TabId) => void
}

/**
 * Declare page and zoom preferences isolated by tab identity.
 * @returns a store declaration instantiated by the document slot for each Session.
 */
export function createPdfStore(): EngineStoreHandle<PdfState, PdfActions> {
  return defineStore({
    init: (): PdfState => ({ byTab: {} }),
    actions: {
      /** @param draft - view state. @param tabId - owning tab. @param page - selected 1-based page. */
      page: (draft, tabId: TabId, page: number) => {
        draft.byTab[tabId] = { ...(draft.byTab[tabId] ?? DEFAULT_PDF_VIEW), page }
      },
      /** @param draft - view state. @param tabId - owning tab. @param zoom - selected scale factor. */
      zoom: (draft, tabId: TabId, zoom: number) => {
        draft.byTab[tabId] = { ...(draft.byTab[tabId] ?? DEFAULT_PDF_VIEW), zoom }
      },
      /** @param draft - view state. @param tabId - closed tab whose preferences are discarded. */
      forget: (draft, tabId: TabId) => {
        const remaining: PdfState['byTab'] = {}
        for (const [id, view] of Object.entries(draft.byTab) as [TabId, PdfView][]) {
          if (id !== tabId) remaining[id] = view
        }
        draft.byTab = remaining
      },
    },
  })
}

/** Store declaration used by the PDF body registration. */
export type PdfStore = ReturnType<typeof createPdfStore>
