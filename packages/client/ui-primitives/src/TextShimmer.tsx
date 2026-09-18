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
  /** Complete animation cycle in seconds; defaults to 1.5 seconds. */
  duration?: number | undefined
  /** Moving-band width multiplier in pixels per character; defaults to eight. */
  spread?: number | undefined
  /** Text color outside the moving band; defaults to the inherited color. */
  baseColor?: string | undefined
  /** Moving band color; defaults to a translucent form of the inherited color. */
  shimmerColor?: string | undefined
  /** Additional inline styles. */
  style?: CSSProperties | undefined
}

function TextShimmerComponent({
  children,
  as: Component = 'span',
  className,
  duration = 1.5,
  spread = 8,
  baseColor,
  shimmerColor,
  style,
}: TextShimmerProps) {
  const dynamicSpread = useMemo(() => children.length * spread, [children, spread])
  const shimmerStyle = {
    ...style,
    '--dsh-text-shimmer-duration': `${duration}s`,
    '--dsh-text-shimmer-spread': `${dynamicSpread}px`,
    '--dsh-text-shimmer-base-color': baseColor ?? 'currentColor',
    '--dsh-text-shimmer-color': shimmerColor ?? 'color-mix(in oklab, currentColor 50%, transparent)',
  } as CSSProperties
  return (
    <Component className={clsx(css.root, className)} style={shimmerStyle} data-text-shimmer="">
      {children}
    </Component>
  )
}

/** Memoized text shimmer with a duration and band width derived from its props. */
export const TextShimmer = memo(TextShimmerComponent)
