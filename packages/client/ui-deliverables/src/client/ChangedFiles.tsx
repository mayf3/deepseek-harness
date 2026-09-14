/** The changed-files card: a folder-opening header, per-file line counts, and a three-row fold. */
import { useState } from 'react'
import { resolveWorkspacePath } from '@deepseek-ai/dsh-util-workspace-path'
import { IconChevronDownOutline14, IconChevronUpOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceChangedFile } from '@deepseek-ai/dsh-workspace-changes/types'
import { changedFileUrl } from '../changes.ts'
import type { PresentedHost } from '../presented.ts'
import { IconCodeBracketsOutline16 } from './icons.tsx'
import type { PresentedOpenPhase } from './present-open.ts'
import type { ChangesTurnData } from './turn-deliverables.ts'
import type { NS } from './locales.ts'
import css from './ChangedFiles.module.css'

/** Rows shown before the fold; the design's summary height for a closing message. */
const COLLAPSED_ROWS = 3

const GROUPED = new Intl.NumberFormat('en-US')

/** Row copy for an open gesture; the changed-files card never reveals, so only open phases occur. */
function rowStatus(phase: PresentedOpenPhase | undefined): { key: 'presented.opening' | 'presented.opened' | 'presented.error' | 'presented.nativeUnavailable'; error: boolean } | undefined {
  switch (phase) {
    case undefined: return undefined
    case 'opening': return { key: 'presented.opening', error: false }
    case 'error': return { key: 'presented.error', error: true }
    case 'nativeUnavailable': return { key: 'presented.nativeUnavailable', error: true }
    default: return { key: 'presented.opened', error: false }
  }
}

function totals(files: readonly WorkspaceChangedFile[]): { added: number; deleted: number } {
  let added = 0
  let deleted = 0
  for (const file of files) {
    added += file.added
    deleted += file.deleted
  }
  return { added, deleted }
}

/**
 * Render one turn's changed files. Rows open files in the Host's default
 * application when a desktop is available and otherwise preview them in the
 * right Sidebar; the header opens the files' common folder only with a desktop.
 * @param props - the recorded summary, Host capabilities, gesture status, openers, and localized copy.
 * @returns the card.
 */
export function ChangedFiles({ changes, cwd, sessionId, host, phases, onOpen, openFile, t }: {
  changes: ChangesTurnData
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
  const sum = totals(changes.files)
  const folderPhase = phases[changedFileUrl(sessionId, changes.seq, null)]
  const folderStatus = folderPhase === 'opening' ? t('changes.folderOpening')
    : folderPhase === 'opened' ? t('changes.folderOpened')
      : folderPhase === undefined ? undefined : t('changes.folderError')
  const summary = <>
    <span className={css.tile}><IconCodeBracketsOutline16 size={18} /></span>
    <span className={css.titles}>
      <span className={css.title}>{t('changes.title', { count: String(changes.total) })}</span>
      <span className={css.stat} role={folderStatus === undefined ? undefined : 'status'} data-error={folderPhase === 'error' || folderPhase === 'nativeUnavailable' ? true : undefined}>
        {folderStatus ?? <>
          <span className={css.added}>{t('changes.added', { count: GROUPED.format(sum.added) })}</span>
          <span className={css.deleted}>{t('changes.deleted', { count: GROUPED.format(sum.deleted) })}</span>
        </>}
      </span>
    </span>
  </>
  return <div className={css.card} data-changed-files>
    {native
      ? <button type="button" className={css.header} aria-label={t('changes.openFolder')}
        disabled={folderPhase === 'opening'} onClick={() => { onOpen(null) }}>{summary}</button>
      : <div className={css.header}>{summary}</div>}
    <ul className={css.list}>
      {rows.map((file, index) => {
        const phase = phases[changedFileUrl(sessionId, changes.seq, index)]
        const status = rowStatus(phase)
        // A file without a verified Host path falls back to the Sidebar preview the status names.
        const opensNatively = native && phase !== 'nativeUnavailable'
        return <li key={file.display}>
          <button type="button" className={css.row} title={resolveWorkspacePath(cwd, file.path)}
            aria-label={t(opensNatively ? 'changes.openFile' : 'presented.previewButton', { name: file.display })}
            disabled={phase === 'opening'}
            onClick={() => { if (opensNatively) onOpen(index); else openFile(file.path) }}>
            <span className={css.path}>{file.display}</span>
            <span className={css.counts} role={status === undefined ? undefined : 'status'} data-error={status?.error ? true : undefined}>
              {status !== undefined ? t(status.key)
                : file.binary === true ? t('changes.binary')
                  : <>
                    <span className={css.added}>{t('changes.added', { count: GROUPED.format(file.added) })}</span>
                    <span className={css.deleted}>{t('changes.deleted', { count: GROUPED.format(file.deleted) })}</span>
                  </>}
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
