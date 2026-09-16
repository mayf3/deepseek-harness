/** Document renderer slot: the owner supplies shared file state, renderers own their presentation. */
import type { PropsRuntime, SlotHookFactory } from '@deepseek-ai/dsh-client-ui-slots'
import type { UseSidebarRightTabInfo } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { RefCallback } from 'react'
import type { SessionFile } from '../rpc.ts'

/** One loaded text window, retaining source line positions. */
export interface DocumentTextPage {
  readonly offset: number
  readonly text: string
  readonly lines: number
}

/**
 * Contents prepared by the preview owner using ordinary file reads.
 * Byte arrays are transient UI input, never persisted layout or Session data.
 */
export type DocumentContent =
  | { readonly kind: 'text'; readonly text: string; readonly pages: readonly DocumentTextPage[]; readonly eof: boolean }
  | { readonly kind: 'bytes'; readonly data: Uint8Array<ArrayBuffer> }

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Document body selected by a registered implementation id. */
    'sidebar.right.tab.document': {
      kind: 'keyed'
      scope: 'session'
      owner: {
        /** Original file address, also readable through the standard useResource hook. */
        readonly resourceAddress: string
        /** Loaded content; text is an accumulated prefix until eof. */
        readonly content: DocumentContent
        /** The document toolbar's current wrapping preference. */
        readonly wrap: boolean
        /** Report a renderer-owned scrollport; passing `null` restores the shared body as the owner. */
        readonly scrollportRef: RefCallback<HTMLElement>
      }
      hookContext: UseSidebarRightTabInfo
      inject: {
        hooks: {
          tabInfo: SlotHookFactory<'sidebar.right.tab.document', UseSidebarRightTabInfo>
        }
      }
    }
    /**
     * Header toolbar contributions acting on the previewed file, rendered
     * after the preview's own controls once the file's Host path is known.
     */
    'sidebar.right.tab.document.actions': {
      kind: 'list'
      scope: 'session'
      owner: {
        /** The previewed file: the Session the read runs under and the path handed to the Host. */
        readonly file: SessionFile
        /** The file's absolute path on the Host, from its metadata. */
        readonly absolutePath: string
      }
    }
    /**
     * Empty-state contributions for a file this preview cannot render,
     * offered where Retry would stand once the file's Host path is known.
     */
    'sidebar.right.tab.document.unpreviewable': {
      kind: 'list'
      scope: 'session'
      owner: {
        /** The previewed file: the Session the read runs under and the path handed to the Host. */
        readonly file: SessionFile
        /** The file's absolute path on the Host, from its metadata. */
        readonly absolutePath: string
      }
    }
  }
}

/** Standard input for every document body; entry-local stores and locale props can be intersected with it. */
export type DocumentPreviewProps = PropsRuntime<'sidebar.right.tab.document'>

/**
 * Forward the framework's tab reader to the selected document body.
 * @param _standard - framework standard props.
 * @param useTabInfo - enclosing tab's bound reader.
 * @returns the same reader, without another subscription adapter.
 */
export const documentTabInfoFactory: SlotHookFactory<'sidebar.right.tab.document', UseSidebarRightTabInfo> =
  (_standard, useTabInfo) => useTabInfo
