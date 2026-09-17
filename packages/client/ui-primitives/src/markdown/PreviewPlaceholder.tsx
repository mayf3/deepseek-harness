/** Stable waiting canvas shared by streaming diagrams and image loading. */
import { memo } from 'react'
import css from './SourcePreview.module.css'

/**
 * Display a quiet loading status without depending on the growing source.
 * @param props - Localized loading announcement.
 * @returns A fixed-height canvas with a decorative pulsing image glyph.
 */
export const PreviewPlaceholder = memo(function PreviewPlaceholder({ label }: { label: string }) {
  return <div className={css.placeholder} data-preview-placeholder role="status">
    <svg className={css.placeholderIcon} viewBox="0 0 32 32" width="32" height="32" fill="none" aria-hidden="true">
      <rect x="4" y="5" width="24" height="22" rx="4" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="11" cy="12" r="2" stroke="currentColor" strokeWidth="1.3" />
      <path d="m5 23 7-7 5 5 4-4 6 6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
    <span>{label}</span>
  </div>
})
