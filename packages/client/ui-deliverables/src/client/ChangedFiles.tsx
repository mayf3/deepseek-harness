/** The changed-files card: a folder-opening header, per-file line counts, and a three-row fold. */
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
 * Gesture state worth showing in place of the counts: pending, or failed. A
 * completed open shows the counts again. The card never reveals, so only open
 * phases occur.
 */
function gesture(phase: PresentedOpenPhase | undefined): { key: 'presented.opening' | 'presented.error' | 'presented.nativeUnavailable'; failed: boolean } | undefined {
  switch (phase) {
    case 'opening': return { key: 'presented.opening', failed: false }
    case 'error': return { key: 'presented.error', failed: true }
    case 'nativeUnavailable': return { key: 'presented.nativeUnavailable', failed: true }
    default: return undefined
  }
}

function sum(files: readonly { added: number; deleted: number }[], key: 'added' | 'deleted'): number {
  return files.reduce((total, file) => total + file[key], 0)
}

/** Added and deleted line counts in the card's colors. */
function Counts({ added, deleted, t }: { added: number; deleted: number } & PropsLocale<typeof NS>) {
  return <>
    <span className={css.added}>{t('changes.added', { count: GROUPED.format(added) })}</span>
    <span className={css.deleted}>{t('changes.deleted', { count: GROUPED.format(deleted) })}</span>
  </>
}

/**
 * Render one turn's changed files. Rows open files in the Host's default
 * application when a desktop is available and otherwise preview them in the
 * right Sidebar; the header opens the files' common folder only with a desktop.
 * @param props - the recorded summary, Host capabilities, gesture status, openers, and localized copy.
 * @returns the card.
 */
export function ChangedFiles({ changes, cwd, sessionId, host, phases, onOpen, openFile, t }: {
  /** The served summary with the sequence of the event that announced it. */
  changes: Pick<ChangesSummary, 'files' | 'total'> & { seq: number }
  cwd: string | undefined
  sessionId: SessionId
  host: PresentedHost | null
  phases: Record<string, PresentedOpenPhase | undefined>
  onOpen: (index: number | null) => void
  openFile: (path: string) => void
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
          ? <Counts t={t} added={sum(changes.files, 'added')} deleted={sum(changes.files, 'deleted')} />
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
      {rows.map((file, index) => {
        const phase = phases[changedFileUrl(sessionId, changes.seq, index)]
        const status = gesture(phase)
        // A file without a verified Host path falls back to the Sidebar preview the status names.
        const opensNatively = native && phase !== 'nativeUnavailable'
        return <li key={file.display}>
          <button type="button" className={css.row} title={resolveWorkspacePath(cwd, file.path)}
            aria-label={t(opensNatively ? 'changes.openFile' : 'presented.previewButton', { name: file.display })}
            disabled={status !== undefined && !status.failed}
            onClick={() => { if (opensNatively) onOpen(index); else openFile(file.path) }}>
            <span className={css.path}>{file.display}</span>
            <span className={css.counts} role={status === undefined ? undefined : 'status'} data-error={status?.failed || undefined}>
              {status !== undefined ? t(status.key)
                : file.binary === true ? t('changes.binary')
                  : <Counts t={t} added={file.added} deleted={file.deleted} />}
            </span>
          </button>
        </li>
      })}
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
