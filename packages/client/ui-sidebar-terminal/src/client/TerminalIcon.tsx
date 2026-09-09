/** Terminal prompt glyph shared by the guide and tab title. */
import type { ReactNode } from 'react'

/** Render the terminal's decorative prompt icon. @returns a sixteen-pixel glyph. */
export function TerminalIcon(): ReactNode {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="m3 4 4 4-4 4M9 12h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
}
