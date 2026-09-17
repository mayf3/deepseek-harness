import { memo, useMemo, type CSSProperties, type ElementType } from 'react'
import clsx from 'clsx'
import css from './TextShimmer.module.css'

/** Text-only shimmer animation shared by live process and tool labels. */
export interface TextShimmerProps {
  /** Visible text whose length determines the highlight width. */
  children: string
  /** Element used for the text wrapper. */
  as?: ElementType | undefined
  /** Additional class applied to the wrapper. */
  className?: string | undefined
  /** One animation cycle in seconds. */
  duration?: number | undefined
  /** Highlight width multiplier in pixels per character. */
  spread?: number | undefined
  /** Base text color behind the moving highlight. */
  baseColor?: string | undefined
  /** Moving highlight color. */
  shimmerColor?: string | undefined
  /** Additional inline styles. */
  style?: CSSProperties | undefined
}

function TextShimmerComponent({
  children,
  as: Component = 'span',
  className,
  duration = 2,
  spread = 3,
  baseColor,
  shimmerColor,
  style,
}: TextShimmerProps) {
  const dynamicSpread = useMemo(() => children.length * spread, [children, spread])
  const shimmerStyle = {
    ...style,
    '--dsh-text-shimmer-duration': `${duration}s`,
    '--dsh-text-shimmer-spread': `${dynamicSpread}px`,
    '--dsh-text-shimmer-base-color': baseColor ?? 'color-mix(in oklab, currentColor 65%, transparent)',
    '--dsh-text-shimmer-color': shimmerColor ?? 'currentColor',
  } as CSSProperties
  return (
    <Component className={clsx(css.root, className)} style={shimmerStyle} data-text-shimmer="">
      {children}
    </Component>
  )
}

/** Memoized text shimmer with a duration and highlight width derived from its props. */
export const TextShimmer = memo(TextShimmerComponent)
