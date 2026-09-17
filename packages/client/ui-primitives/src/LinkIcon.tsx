/**
 * Leading current-color category glyphs for clickable artifact links. The
 * public component keeps individual artwork private to the link vocabulary.
 */
import type { ReactNode } from 'react'
import { classifyFileType, fileExtension } from './FileTypeIcon.tsx'
import { isCodeFileType, isLinkCodeExtension } from './code-file-types.ts'
import { siteGlyph } from './SiteGlyph.tsx'
import type { IconProps } from './icons/props.ts'

/** Link categories with distinct leading glyphs. */
export type LinkIconKind = 'url' | 'folder' | 'code' | 'image' | 'document' | 'other'

/** Props for link icons: the category plus the shared icon sizing seat. */
export interface LinkIconProps extends IconProps {
  kind: LinkIconKind
  /** Destination of a URL link; known HTTP(S) hosts render their site mark. */
  href?: string | undefined
}

interface WeightedLinkIconProps extends LinkIconProps {
  strokeWidth: number
}

/**
 * Derive a file path's link-icon category from its extension. Unknown and
 * missing extensions fall to `other` (the plain-paper glyph).
 * @param path - File path as the producing tool spelled it (either separator).
 * @returns The file's glyph category; never `url` or `folder`.
 */
export function classifyLinkPath(path: string): LinkIconKind {
  const type = classifyFileType(path)
  const extension = fileExtension(path)
  if (isCodeFileType(type)) return isLinkCodeExtension(extension) ? 'code' : 'other'
  if (extension === '') return 'other'
  switch (type) {
    case 'code':
    case 'html': return 'code'
    case 'image': return 'image'
    case 'excel':
    case 'pdf':
    case 'ppt':
    case 'word': return 'document'
    case 'markdown':
    case 'other':
    case 'video': return 'other'
    /* v8 ignore next -- classifyFileType returns a closed union exhausted above */
    default: return assertNever(type)
  }
}

const GlobeGlyph = ({ size, className, strokeWidth }: IconProps & { strokeWidth: number }) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
    <path d="M7.99986 14.0887C11.3626 14.0887 14.0886 11.3627 14.0886 7.99998C14.0886 4.63727 11.3626 1.91125 7.99986 1.91125C4.63715 1.91125 1.91113 4.63727 1.91113 7.99998C1.91113 11.3627 4.63715 14.0887 7.99986 14.0887Z" stroke="currentColor" />
    <path d="M2.34619 8H13.6538" stroke="currentColor" strokeLinecap="square" />
    <path d="M7.99976 14.0889C9.23509 14.0889 10.1743 11.3629 10.1743 8.00006C10.1743 4.63739 9.23509 1.91138 7.99976 1.91138" stroke="currentColor" />
    <path d="M7.99973 14.0889C6.76445 14.0889 5.8252 11.3629 5.8252 8.00006C5.8252 4.63739 6.76445 1.91138 7.99973 1.91138" stroke="currentColor" />
  </svg>
)

const FolderGlyph = ({ size, className, strokeWidth }: IconProps & { strokeWidth: number }) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
    <path d="M1.50439 3.11059C1.50439 2.55831 1.95211 2.1106 2.50439 2.1106H5.43389C5.67773 2.1106 5.91318 2.19969 6.09593 2.36113L7.71649 3.79265C7.89924 3.95409 8.1347 4.04319 8.3785 4.04319H13.4958C14.0481 4.04319 14.4958 4.4909 14.4958 5.04319V12.8894C14.4958 13.4417 14.0481 13.8894 13.4958 13.8894H2.50439C1.95211 13.8894 1.50439 13.4417 1.50439 12.8894V4.04319V3.11059Z" stroke="currentColor" />
    <path d="M3.63501 7.66614H12.3647" stroke="currentColor" />
  </svg>
)

const CodeGlyph = ({ size, className, strokeWidth }: IconProps & { strokeWidth: number }) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
    <path d="M4.67398 4.25061L1.36094 7.86484C1.29085 7.9413 1.29085 8.05866 1.36094 8.13513L4.67398 11.7494" stroke="currentColor" />
    <path d="M11.3262 4.25061L14.6392 7.86484C14.7093 7.9413 14.7093 8.05866 14.6392 8.13513L11.3262 11.7494" stroke="currentColor" />
    <path d="M9.56222 3.62573L6.43774 12.3743" stroke="currentColor" />
  </svg>
)

const PhotoGlyph = ({ size, className, strokeWidth }: IconProps & { strokeWidth: number }) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
    <path d="M12.4326 2.38086H3.56763C2.46306 2.38086 1.56763 3.27629 1.56763 4.38086V11.6192C1.56763 12.7237 2.46306 13.6192 3.56763 13.6192H12.4326C13.5372 13.6192 14.4326 12.7237 14.4326 11.6192V4.38086C14.4326 3.27629 13.5372 2.38086 12.4326 2.38086Z" stroke="currentColor" />
    <path d="M10.536 7.03286C11.1948 7.03286 11.7288 6.49884 11.7288 5.8401C11.7288 5.18136 11.1948 4.64734 10.536 4.64734C9.87728 4.64734 9.34326 5.18136 9.34326 5.8401C9.34326 6.49884 9.87728 7.03286 10.536 7.03286Z" stroke="currentColor" />
    <path d="M1.5979 9.28409L4.17738 7.37514C4.57462 7.08117 5.12701 7.12145 5.47741 7.46992L8.3322 10.309C8.6572 10.6323 9.1605 10.6931 9.5532 10.4566L10.8859 9.65399C11.2531 9.43289 11.7205 9.47039 12.0477 9.74729L14.2823 11.6379" stroke="currentColor" />
  </svg>
)

const PaperDocGlyph = ({ size, className, strokeWidth }: IconProps & { strokeWidth: number }) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
    <path d="M3.51919 14.5069H12.4807C13.0679 14.5069 13.5438 14.031 13.5438 13.4438V5.97499C13.5438 5.68818 13.428 5.41352 13.2226 5.21341L9.71251 1.79459C9.51402 1.60124 9.24781 1.49304 8.97075 1.49304H3.51919C2.93204 1.49304 2.45605 1.96902 2.45605 2.55618V13.4438C2.45605 14.031 2.93203 14.5069 3.51919 14.5069Z" stroke="currentColor" />
    <path d="M8.90454 1.6095V4.87091C8.90454 5.45806 9.38051 5.93405 9.96768 5.93405H13.4953" stroke="currentColor" />
    <path d="M4.31152 8.7561H7.83046" stroke="currentColor" />
    <path d="M4.31152 11.3651H9.36598" stroke="currentColor" />
  </svg>
)

const PaperGlyph = ({ size, className, strokeWidth }: IconProps & { strokeWidth: number }) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={strokeWidth}>
    <path d="M3.75275 14.271H12.2473C12.7749 14.271 13.2027 13.8433 13.2027 13.3156V5.91732C13.2027 5.65958 13.0985 5.41276 12.9139 5.23293L9.59477 2.00011C9.4164 1.82636 9.17717 1.72913 8.9282 1.72913H3.75275C3.22511 1.72913 2.79736 2.15686 2.79736 2.68451V13.3156C2.79736 13.8433 3.22511 14.271 3.75275 14.271Z" stroke="currentColor" />
    <path d="M8.84888 1.83838V4.94133C8.84888 5.46896 9.2766 5.89671 9.80426 5.89671H13.157" stroke="currentColor" />
  </svg>
)

/** Local exhaustiveness helper — this package does not depend on `dsh-llm`. */
/* v8 ignore next 3 -- closed-union backstop; only reached if a kind is forged */
function assertNever(value: never): never {
  throw new Error(`unreachable link icon kind: ${String(value)}`)
}

/**
 * Render the leading glyph for one clickable artifact link at one stroke weight.
 * @param props - The link category, optional size (default 14px), and optional CSS class.
 * @returns The category's decorative current-color SVG glyph.
 */
function LinkIconArtwork({ kind, href, size = 14, className, strokeWidth }: WeightedLinkIconProps): ReactNode {
  switch (kind) {
    case 'url': return siteGlyph({ href, size, className }) ?? <GlobeGlyph size={size} className={className} strokeWidth={strokeWidth} />
    case 'folder': return <FolderGlyph size={size} className={className} strokeWidth={strokeWidth} />
    case 'code': return <CodeGlyph size={size} className={className} strokeWidth={strokeWidth} />
    case 'image': return <PhotoGlyph size={size} className={className} strokeWidth={strokeWidth} />
    case 'document': return <PaperDocGlyph size={size} className={className} strokeWidth={strokeWidth} />
    case 'other': return <PaperGlyph size={size} className={className} strokeWidth={strokeWidth} />
    /* v8 ignore next -- closed-union backstop; only reached if a kind is forged */
    default: return assertNever(kind)
  }
}

/**
 * Render a regular one-pixel link icon.
 * @param props - Link category, size, and optional class.
 * @returns The regular decorative link glyph.
 */
export function LinkIconRegular(props: LinkIconProps): ReactNode {
  return <LinkIconArtwork {...props} strokeWidth={1} />
}

/**
 * Render a medium 1.3px link icon.
 * @param props - Link category, size, and optional class.
 * @returns The medium decorative link glyph.
 */
export function LinkIconMedium(props: LinkIconProps): ReactNode {
  return <LinkIconArtwork {...props} strokeWidth={1.3} />
}
