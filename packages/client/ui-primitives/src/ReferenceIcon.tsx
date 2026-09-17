import type { ReactNode } from 'react'
import { ICON_MEDIUM_STROKE, ICON_REGULAR_STROKE } from './icons/index.tsx'
import type { IconProps } from './icons/props.ts'

/** Reference domains with distinct composer and transcript glyphs. */
export type ReferenceIconKind = 'session' | 'file' | 'folder'

/** Props shared by inline reference glyphs. */
export interface ReferenceIconProps extends IconProps {
  kind: ReferenceIconKind
}

interface WeightedReferenceIconProps extends ReferenceIconProps {
  strokeWidth: number
}

const SessionGlyph = ({ size, className, strokeWidth }: IconProps & { strokeWidth: number }) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
    <path d="M2.37091 11.2501C1.58745 9.89288 1.32067 8.29835 1.61969 6.76006C1.91872 5.22177 2.76342 3.8433 3.99826 2.87846C5.2331 1.91362 6.77494 1.42737 8.33988 1.50925C9.90482 1.59113 11.3875 2.23562 12.5149 3.32406C13.6425 4.41269 14.3387 5.87206 14.4754 7.4334C14.612 8.99474 14.18 10.5529 13.2587 11.8209C12.3375 13.0888 10.9891 13.9813 9.46194 14.3337C8.18691 14.628 6.85895 14.5294 5.64989 14.0605C5.1712 13.8748 4.76962 13.4932 4.26534 13.3967C3.67413 13.2835 2.95257 13.5598 2.03794 14.3337" stroke="currentColor" />
    <path d="M8 5V11" stroke="currentColor" />
    <path d="M5 8H11" stroke="currentColor" />
  </svg>
)

const FileGlyph = ({ size, className, strokeWidth }: IconProps & { strokeWidth: number }) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
    <path d="M4.9375 5.90295H11.0625" stroke="currentColor" />
    <path d="M4.9375 9.02991H8.27841" stroke="currentColor" />
    <path d="M12.5 1.32617C13.3039 1.32617 14 1.95171 14 2.77637V13.2246C13.9996 14.0489 13.3036 14.6738 12.5 14.6738H3.5C2.69637 14.6738 2.00042 14.0489 2 13.2246V2.77637C2 1.95171 2.69613 1.32617 3.5 1.32617H12.5ZM3.5 2.32617C3.1993 2.32617 3 2.55186 3 2.77637V13.2246C3.00044 13.4489 3.19963 13.6738 3.5 13.6738H12.5C12.8004 13.6738 12.9996 13.4489 13 13.2246V2.77637C13 2.55186 12.8007 2.32617 12.5 2.32617H3.5Z" fill="currentColor" />
  </svg>
)

const FolderGlyph = ({ size, className, strokeWidth }: IconProps & { strokeWidth: number }) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
    <path d="M1.50439 3.11059C1.50439 2.55831 1.95211 2.1106 2.50439 2.1106H5.43389C5.67773 2.1106 5.91318 2.19969 6.09593 2.36113L7.71649 3.79265C7.89924 3.95409 8.1347 4.04319 8.3785 4.04319H13.4958C14.0481 4.04319 14.4958 4.4909 14.4958 5.04319V12.8894C14.4958 13.4417 14.0481 13.8894 13.4958 13.8894H2.50439C1.95211 13.8894 1.50439 13.4417 1.50439 12.8894V4.04319V3.11059Z" stroke="currentColor" />
    <path d="M3.63501 7.66614H12.3647" stroke="currentColor" />
  </svg>
)

/**
 * Render the icon that identifies one inline reference domain.
 * @param props - Reference kind, optional size, and optional CSS class.
 * @returns The corresponding decorative current-color SVG glyph.
 */
function ReferenceIconArtwork({ kind, size = 16, className, strokeWidth }: WeightedReferenceIconProps): ReactNode {
  switch (kind) {
    case 'session': return <SessionGlyph size={size} className={className} strokeWidth={strokeWidth} />
    case 'file': return <FileGlyph size={size} className={className} strokeWidth={strokeWidth} />
    case 'folder': return <FolderGlyph size={size} className={className} strokeWidth={strokeWidth} />
  }
}

/**
 * Render a regular one-pixel reference icon.
 * @param props - Reference kind, size, and optional class.
 * @returns The regular decorative reference glyph.
 */
export function ReferenceIconRegular(props: ReferenceIconProps): ReactNode {
  return <ReferenceIconArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
}

/**
 * Render a medium 1.3px reference icon.
 * @param props - Reference kind, size, and optional class.
 * @returns The medium decorative reference glyph.
 */
export function ReferenceIconMedium(props: ReferenceIconProps): ReactNode {
  return <ReferenceIconArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
}
