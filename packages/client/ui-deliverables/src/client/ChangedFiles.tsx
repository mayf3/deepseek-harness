/** The changed-files card: a folder-opening header, per-file line counts opening the turn's review on that file, and a three-row fold. */
import { useState } from 'react'
import { resolveWorkspacePath } from '@deepseek-ai/dsh-util-workspace-path'
import { IconChevronDownOutline14, IconChevronUpOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { changedFileUrl, type ChangesSummary } from '../changes.ts'
import type { PresentedHost } from '../presented.ts'
import { IconCodeBracketsOutline16 } from './icons.tsx'
import type { PresentedOpenPhase } from './present-open.ts'
import type { NS } from './locales.ts'
import css from './ChangedFiles.module.css'

/** Rows shown before the fold; the design's summary height for a closing message. */
const COLLAPSED_ROWS = 3

const GROUPED = new Intl.NumberFormat('en-US')

/**
 * Folder gesture state worth showing in place of the totals: pending, or
 * failed. A completed open shows the totals again. The card never reveals, so
 * only open phases occur.
 */
function gesture(phase: PresentedOpenPhase | undefined): { key: 'presented.opening' | 'presented.error' | 'presented.nativeUnavailable'; failed: boolean } | undefined {
  switch (phase) {
    case 'opening': return { key: 'presented.opening', failed: false }
    case 'error': return { key: 'presented.error', failed: true }
    case 'nativeUnavailable': return { key: 'presented.nativeUnavailable', failed: true }
    default: return undefined
  }
}

/** Added and deleted line counts in the card's colors. */
function Counts({ added, deleted, t }: { added: number; deleted: number } & PropsLocale<typeof NS>) {
  return <>
    <span className={css.added}>{t('changes.added', { count: GROUPED.format(added) })}</span>
    <span className={css.deleted}>{t('changes.deleted', { count: GROUPED.format(deleted) })}</span>
  </>
}

/**
 * Render one turn's changed files. Each row opens the turn's review in the
 * right Sidebar on that file; the header opens the files' common folder only
 * with a Host desktop.
 * @param props - the recorded summary, Host capabilities, folder gesture status, openers, and localized copy.
 * @returns the card.
 */
export function ChangedFiles({ changes, cwd, sessionId, host, phases, onOpen, openReview, t }: {
  /** The served summary with the sequence of the event that announced it. */
  changes: Pick<ChangesSummary, 'files' | 'total' | 'added' | 'deleted'> & { seq: number }
  cwd: string | undefined
  sessionId: SessionId
  host: PresentedHost | null
  phases: Record<string, PresentedOpenPhase | undefined>
  onOpen: (index: number | null) => void
  /** Open the turn's review on the file at an original summary index. */
  openReview: (index: number) => void
} & PropsLocale<typeof NS>) {
  const [expanded, setExpanded] = useState(false)
  const native = host !== null && host.available
  const foldable = changes.files.length > COLLAPSED_ROWS
  const rows = foldable && !expanded ? changes.files.slice(0, COLLAPSED_ROWS) : changes.files
  const folder = gesture(phases[changedFileUrl(sessionId, changes.seq, null)])
  const summary = <>
    <span className={css.tile}><IconCodeBracketsOutline16 size={18} /></span>
    <span className={css.titles}>
      <span className={css.title}>{t('changes.title', { count: String(changes.total) })}</span>
      <span className={css.stat} role={folder === undefined ? undefined : 'status'} data-error={folder?.failed || undefined}>
        {folder === undefined
          ? <Counts t={t} added={changes.added} deleted={changes.deleted} />
          : t(folder.failed ? 'changes.folderError' : 'changes.folderOpening')}
      </span>
    </span>
  </>
  return <div className={css.card} data-changed-files>
    {native
      ? <button type="button" className={css.header} aria-label={t('changes.openFolder')}
        disabled={folder !== undefined && !folder.failed} onClick={() => { onOpen(null) }}>{summary}</button>
      : <div className={css.header}>{summary}</div>}
    <ul className={css.list}>
      {rows.map((file, index) => (
        <li key={file.display}>
          <button type="button" className={css.row} title={resolveWorkspacePath(cwd, file.path)}
            aria-label={t('changes.viewDiff', { name: file.display })}
            onClick={() => { openReview(index) }}>
            <span className={css.path}>{file.display}</span>
            <span className={css.counts}>
              {file.binary === true ? t('changes.binary')
                : file.oversized === true ? t('changes.oversized')
                  : <Counts t={t} added={file.added} deleted={file.deleted} />}
            </span>
          </button>
        </li>
      ))}
    </ul>
    {foldable && <button type="button" className={css.toggle}
      aria-expanded={expanded}
      aria-label={t(expanded ? 'changes.collapseAria' : 'changes.expandAria', { count: String(changes.files.length) })}
      onClick={() => { setExpanded(value => !value) }}>
      <span>{t(expanded ? 'changes.collapse' : 'changes.all', { count: String(changes.files.length) })}</span>
      {expanded ? <IconChevronUpOutline14 /> : <IconChevronDownOutline14 />}
    </button>}
  </div>
}
