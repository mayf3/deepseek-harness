/** One operation notice on the plugin management page. */

import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ManagerNotice } from './manager-store.ts'
import { noticeText, type Translate } from './presentation.ts'
import css from './PluginManagerPage.module.css'

/**
 * Render the last operation's notice with its dismiss button, or nothing while there is none.
 * @param props - the notice, the translator, and the dismiss handler.
 * @returns the notice paragraph, or null.
 */
export function NoticeLine({ notice, t, onDismiss }: {
  readonly notice: ManagerNotice | null
  readonly t: Translate
  readonly onDismiss: () => void
}): ReactNode {
  if (notice === null) return null
  return (
    <p className={css.notice} data-kind={notice.kind} role={notice.kind === 'failed' ? 'alert' : 'status'}>
      <span>{noticeText(notice, t)}</span>
      <Button variant="ghost" size="sm" onClick={onDismiss}>{t('dismiss')}</Button>
    </p>
  )
}
