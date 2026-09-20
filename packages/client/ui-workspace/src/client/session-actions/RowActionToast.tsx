/**
 * The `shell.overlay` entry for Workspace and Session notices.
 * One notice is visible at a time; a parent rerender does not extend its hold.
 */
import { IconWarningOutlineRegular, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { RowToastProps } from '../contract/slots.ts'

/** Hold for the actionable archived notice: two buttons need a longer read-and-react window than a plain notice. */
const ARCHIVED_TOAST_HOLD_MS = 6000

/**
 * Render the current notice: the archived notice with its undo
 * and show-archived actions on a 6 s hold, or a plain warning for a failed
 * pin, an archived row that was clicked, or default Workspace creation.
 * @param props - the notice hook, its dismissal, the two archived-notice actions, and the locale seat.
 * @returns the notice on display, or null.
 */
export function RowActionToast({ useToast, dismissToast, undoArchive, showArchived, t }: RowToastProps) {
  const toast = useToast(current => current)
  if (toast === null) return null
  if (toast.kind === 'archived') {
    const { sessionId } = toast
    return (
      <Toast
        key={`toast-${String(toast.seq)}`}
        text={t('toast.archived')}
        tone="success"
        holdMs={ARCHIVED_TOAST_HOLD_MS}
        actions={[
          { label: t('toast.archivedUndo'), onClick: () => { dismissToast(); undoArchive(sessionId) } },
          { prefix: t('toast.archivedOr'), label: t('toast.archivedFilter'), onClick: () => { dismissToast(); showArchived() } },
        ]}
        onDone={dismissToast}
      />
    )
  }
  const text = toast.kind === 'pinFailed'
    ? t('toast.pinFailed')
    : toast.kind === 'unpinFailed' ? t('toast.unpinFailed')
      : toast.kind === 'defaultWorkspaceFailed' ? t('defaultWorkspace.failed') : t('toast.archivedNotOpenable')
  return (
    <Toast
      key={`toast-${String(toast.seq)}`}
      text={text}
      icon={<IconWarningOutlineRegular />}
      onDone={dismissToast}
    />
  )
}
