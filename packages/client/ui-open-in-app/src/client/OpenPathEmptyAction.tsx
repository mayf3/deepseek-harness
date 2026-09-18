/** Empty-state contribution: open a file the document preview cannot render in its default application. */
import type { ReactNode } from 'react'
import { IconRightUpOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'
import type { NS } from './locales.ts'
import { usePathGesture, type OpenPathInjected } from './OpenPathAction.tsx'
import css from './OpenPathEmptyAction.module.css'

/** Full props of the unpreviewable empty-state contribution. */
export type OpenPathEmptyActionProps =
  PropsRuntime<'sidebar.right.tab.document.unpreviewable'>
  & PropsLocale<typeof NS>
  & InjectFace<OpenPathInjected>

/**
 * Render the default-application open button, or nothing until the Host reports a desktop.
 * @param props - the unpreviewable file, the injected face, and copy.
 * @returns the open button and its toast, or null.
 */
export function OpenPathEmptyAction(props: OpenPathEmptyActionProps): ReactNode {
  const { t } = props
  const { available, pending, toast, act } = usePathGesture(props)
  if (!available) return null
  return (
    <>
      <button
        type="button"
        className={css.open}
        disabled={pending}
        data-open-path-unpreviewable
        onClick={() => { act('open') }}
      >
        {t('path.unpreviewable')}
        <IconRightUpOutlineRegular size={14} />
      </button>
      {toast}
    </>
  )
}
