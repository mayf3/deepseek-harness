/**
 * Stage one of this package's registration: what the `files` tab type IS.
 *
 * The type is a page, not a viewer: it claims no address. The guide page offers
 * it as an entry box, and the tree opens files through `tabActions.openResource`
 * for the `dsh-resource://file` viewers to claim.
 */
import type { ShortcutCommandId } from '@deepseek-ai/dsh-client-shortcuts/client'
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import type {} from './locales.ts'
import type { IconProps } from '@deepseek-ai/dsh-client-ui-primitives'

/** The tab kind this package owns. */
export const FILES_KIND = 'files'

/** This implementation's identity in the tab system, and the key its body registers under. */
export const FILES_ID = '@deepseek-ai/dsh-client-ui-sidebar-files'

/** Yellow folder artwork for the guide entry. */
function FolderSheetGlyph({ size = 36, className }: IconProps) {
  return (
    <svg width={size} height={size} className={className} aria-hidden="true" viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M10.7603 27.922H24.6817C26.3441 27.922 27.1753 27.922 27.8102 27.5984C28.3687 27.3139 28.8228 26.8598 29.1074 26.3012C29.4309 25.6663 29.4309 24.8351 29.4309 23.1727V15.4936" stroke="#FFCD78" strokeWidth="1.97886" />
      <path d="M13.1597 8.07812C13.4182 8.07818 13.6727 8.14336 13.8989 8.26855L16.7554 9.84961C16.9817 9.97485 17.2369 10.041 17.4956 10.041H26.106C26.9492 10.0412 27.6323 10.7251 27.6323 11.5684V24.5371C27.6323 25.3805 26.9483 26.0645 26.105 26.0645H8.09619C7.25281 26.0645 6.56884 25.3805 6.56885 24.5371V9.60449C6.56909 8.76133 7.25297 8.07812 8.09619 8.07812H13.1597ZM9.81592 14.5508V16.5293H24.3999V14.5508H9.81592Z" fill="#FFBC4D" />
    </svg>
  )
}

/**
 * The files type's registry definition.
 * @param t - namespace-bound translate, read fresh on every label call.
 * @returns the definition to register.
 */
export function filesDefinition(t: TranslateNS<'sidebarFiles'>): SidebarRightTabDefinition {
  return {
    id: FILES_ID,
    kind: FILES_KIND,
    priority: 'builtin',
    title: () => t('type.label'),
    guide: [{
      id: 'workspace',
      commandId: 'workspace.files' as ShortcutCommandId,
      order: 10,
      title: () => t('guide.title'),
      description: () => t('guide.description'),
      icon: FolderSheetGlyph,
    }],
  }
}
