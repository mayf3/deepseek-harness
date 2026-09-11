/** Shared indeterminate loading feedback for document reads and rendering. */
import type { ReactNode } from 'react'
import clsx from 'clsx'
import { IconLoadingOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './LoadingIndicator.module.css'

/**
 * @param props - localized status label, optional placement style, and
 * `iconOnly` to keep the label as the accessible name without visible text.
 * @returns an animated, accessible loading status.
 */
export function LoadingIndicator({ label, className, iconOnly = false }: {
  label: string
  className?: string | undefined
  iconOnly?: boolean
}): ReactNode {
  return <span className={clsx(css.loading, className)} role="status" aria-label={iconOnly ? label : undefined} data-document-loading>
    <span className={css.icon} aria-hidden="true"><IconLoadingOutline16 /></span>
    {!iconOnly && <span>{label}</span>}
  </span>
}
