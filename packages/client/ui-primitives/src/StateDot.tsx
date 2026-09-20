import clsx from 'clsx'
import css from './StateDot.module.css'
import { IconCheckOutlineRegular } from './icons/index.tsx'

/**
 * State semantic: green done / amber user-attention / tertiary-grey loading /
 * red error / neutral-grey idle for a tracked subject with nothing in progress.
 */
export type StateDotState = 'done' | 'warning' | 'ongoing' | 'error' | 'idle'

/**
 * Render a state dot.
 * @param props.state - which of `done`, `warning`, `ongoing`, `error`, or `idle` to show.
 * @param props.size - outer diameter in px; defaults to 14 for ongoing and 10 for solid states.
 * @param props.className - extra class for layout placement.
 * @param props.appearance - compact dot by default; step uses a filled check or hollow pending circle.
 * @returns the dot element (aria-hidden; pair with text for accessibility).
 */
export function StateDot({ state, size, className, appearance = 'dot' }: {
  state: StateDotState
  size?: number | undefined
  className?: string | undefined
  appearance?: 'dot' | 'step'
}) {
  const edge = size ?? (state === 'ongoing' ? 14 : 10)
  if (state === 'ongoing') {
    return (
      <svg
        className={clsx(css.spinner, className)}
        data-state="ongoing"
        width={edge}
        height={edge}
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <g className={css.spinnerMotion}>
          <circle className={css.spinnerTrack} cx="12" cy="12" r="9.5" />
          <circle className={css.spinnerArc} cx="12" cy="12" r="9.5" />
        </g>
      </svg>
    )
  }
  return (
    <span
      className={clsx(appearance === 'step' ? css.step : css.dot, className)}
      data-state={state}
      style={{ width: edge, height: edge }}
      aria-hidden="true"
    >{appearance === 'step' && state === 'done' && <IconCheckOutlineRegular size={edge - 2} />}</span>
  )
}
