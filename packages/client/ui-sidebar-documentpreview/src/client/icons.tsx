/**
 * Glyphs this package draws that the shared icon set does not carry yet.
 * Same props contract as `@deepseek-ai/dsh-client-ui-primitives` icons, so a
 * shared replacement is a one-line import change.
 *
 * The wrap control swaps between the two glyphs below to preview the mode a
 * click switches to, so neither needs a pressed style.
 */
import type { IconProps } from '@deepseek-ai/dsh-client-ui-primitives'

/** Two margin bars, a straight arrow running to the right one: lines run past the edge. */
export const IconNowrapFill16 = ({ size = 16, className }: IconProps) => (
  <svg
    width={size}
    height={size}
    className={className}
    viewBox="0 0 16 16"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path d="M2 15H1V1H2V15Z" fill="currentColor" />
    <path d="M12.3535 7.64645C12.5487 7.84171 12.5487 8.15829 12.3535 8.35355L9.85352 10.8535L9.14648 10.1465L10.793 8.5H3.5V7.5H10.793L9.14648 5.85352L9.85352 5.14648L12.3535 7.64645Z" fill="currentColor" />
    <path d="M15 15H14V1H15V15Z" fill="currentColor" />
  </svg>
)

/** Two margin bars, an arrow sweeping around and back left: lines turn under themselves. */
export const IconWrapFill16 = ({ size = 16, className }: IconProps) => (
  <svg
    width={size}
    height={size}
    className={className}
    viewBox="0 0 16 16"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path d="M10.9999 8C10.9999 6.89543 10.1046 6 9 6H4.5V5H9C10.6568 5 11.9999 6.34315 11.9999 8C11.9999 9.65685 10.6568 11 9 11H6.20703L6.85351 11.6465L6.14648 12.3535L4.64652 10.8536C4.45126 10.6583 4.45126 10.3417 4.64652 10.1464L6.14648 8.64648L6.85351 9.35352L6.20703 10H9C10.1046 10 10.9999 9.10457 10.9999 8Z" fill="currentColor" />
    <path d="M2 15H1V1H2V15Z" fill="currentColor" />
    <path d="M15 15H14V1H15V15Z" fill="currentColor" />
  </svg>
)
