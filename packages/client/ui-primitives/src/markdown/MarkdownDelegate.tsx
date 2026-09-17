/** Consumer-owned navigation for ordinary Markdown HTTP(S) link activation. */
import { createContext, useContext } from 'react'
import type { ReactNode } from 'react'

/**
 * Handle one sanitized absolute HTTP(S) URL selected from Markdown.
 * @param href - destination URL.
 */
export type MarkdownExternalLinkHandler = (href: string) => void

const MarkdownDelegateContext = createContext<MarkdownExternalLinkHandler | undefined>(undefined)

/** Props for one Markdown navigation scope. */
export interface MarkdownDelegateProviderProps {
  readonly children: ReactNode
  readonly openExternalLink: MarkdownExternalLinkHandler
}

/**
 * Delegate ordinary Markdown HTTP(S) activation without threading callbacks through renderers.
 * @param props - child tree and its link handler.
 * @returns the scoped child tree.
 */
export function MarkdownDelegateProvider({
  children,
  openExternalLink,
}: MarkdownDelegateProviderProps): ReactNode {
  return (
    <MarkdownDelegateContext.Provider value={openExternalLink}>
      {children}
    </MarkdownDelegateContext.Provider>
  )
}

/** Read the nearest optional Markdown HTTP(S) navigation delegate. */
export function useMarkdownExternalLinkDelegate(): MarkdownExternalLinkHandler | undefined {
  return useContext(MarkdownDelegateContext)
}
