/** One activity highlight across a row's text and separators. */
import { createContext, memo, useContext, type ReactNode } from 'react'
import clsx from 'clsx'
import css from './Shimmer.module.css'

const DecorativeCopy = createContext(false)

/** Presentational content shared by the visible row and its inert highlight. */
export interface ShimmerProps {
  /** Text and layout elements; keep icons outside and use ShimmerText for text. No effects or element ids. */
  children: ReactNode
  /** Whether the row's owning operation is running. */
  active: boolean
  /** Additional class applied to the retained wrapper. */
  className?: string | undefined
  /** Layout class applied equally to the base and decorative content. */
  contentClassName?: string | undefined
}

/**
 * Sweep one highlight across the visible width of a row's text; place icons outside.
 * Children also render in an inert, aria-hidden decoration while active; keep
 * state and subscriptions above this component and supply presentational nodes.
 * The decoration is clipped to the row without extending its scrollable area.
 * @param props - row content, activity, and layout classes.
 * @returns the stable base row and optional masked decoration.
 */
export const Shimmer = memo(function Shimmer({ children, active, className, contentClassName }: ShimmerProps) {
  return (
    <span className={clsx(css.root, className)} data-shimmer={active}>
      <span className={clsx(css.content, contentClassName)}>{children}</span>
      {/* React 18 emits inert as a string attribute; React 19 requires boolean true. */}
      {active && (
        <span className={css.decoration} aria-hidden="true" {...{ inert: '' }}>
          <span className={css.sweep}>
            <DecorativeCopy.Provider value>
              <span className={clsx(css.content, css.highlight, contentClassName)}>{children}</span>
            </DecorativeCopy.Provider>
          </span>
        </span>
      )}
    </span>
  )
})

/** Text rendered once for selection and accessibility, with generated decoration. */
export interface ShimmerTextProps {
  /** Visible, already-localized text. */
  children: string
  /** Typography and truncation class applied to both copies. */
  className?: string | undefined
}

/**
 * Render row text without duplicating its selectable or accessible content.
 * @param props - text and owner styling.
 * @returns text in the base row or generated text in its decoration.
 */
export const ShimmerText = memo(function ShimmerText({ children, className }: ShimmerTextProps) {
  const decorative = useContext(DecorativeCopy)
  return (
    <span className={clsx(css.text, className)} data-shimmer-text={decorative ? children : undefined}>
      {decorative ? null : children}
    </span>
  )
})
