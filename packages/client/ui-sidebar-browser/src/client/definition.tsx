/** Static Browser tab type and guide declaration. */
import type { ShortcutCommandId } from '@deepseek-ai/dsh-client-shortcuts/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import type { IconProps } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from './locales.ts'

/** Browser tab kind. */
export const BROWSER_KIND = 'browser'

/** Browser implementation identity and keyed Slot dispatch key. */
export const BROWSER_ID = '@deepseek-ai/dsh-client-ui-sidebar-browser'

/** Blue globe artwork for the guide entry. */
function BrowserGuideIcon({ size = 36, className }: IconProps) {
  return (
    <svg width={size} height={size} className={className} aria-hidden="true" viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M17.9995 28.1465C23.6034 28.1465 28.1461 23.6038 28.1461 18C28.1461 12.3963 23.6034 7.85352 17.9995 7.85352C12.3958 7.85352 7.85303 12.3963 7.85303 18C7.85303 23.6038 12.3958 28.1465 17.9995 28.1465Z" stroke="#539CFA" strokeWidth="2" />
      <path d="M8.57764 18H27.4211" stroke="#539CFA" strokeWidth="2" strokeLinecap="square" />
      <path d="M17.999 28.1467C20.0576 28.1467 21.6228 23.6039 21.6228 18C21.6228 12.3963 20.0576 7.85352 17.999 7.85352" stroke="#539CFA" strokeWidth="2" />
      <path d="M17.9992 28.1467C15.9407 28.1467 14.3755 23.6039 14.3755 18C14.3755 12.3963 15.9407 7.85352 17.9992 7.85352" stroke="#539CFA" strokeWidth="2" />
    </svg>
  )
}

/** Build the Browser type with locale-live copy. */
export function browserDefinition(t: TranslateNS<'sidebarBrowser'>): SidebarRightTabDefinition {
  return {
    id: BROWSER_ID,
    kind: BROWSER_KIND,
    multiple: true,
    priority: 'builtin',
    title: () => t('type.label'),
    guide: [{
      id: 'new', commandId: 'browser.new' as ShortcutCommandId, order: 30, title: () => t('guide.title'),
      description: () => t('guide.description'), icon: BrowserGuideIcon,
    }],
  }
}
