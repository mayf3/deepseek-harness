/** The changed-file comparison tab: a path header with the native-open control, then the hunks the Host served. */
import { useEffect, useMemo } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { pathPartsOf } from '@deepseek-ai/dsh-util-workspace-path'
import type { WorkspaceDiffHunk } from '@deepseek-ai/dsh-workspace-changes/types'
import { changedFileUrl, changesDiffUrl, parseChangesDiffAddress, type ChangesDiff } from '../changes.ts'
import type { ChangesDiffStore } from './changes-diff.ts'
import type { PresentedOpenController } from './present-open.ts'
import type { NS } from './locales.ts'
import css from './DiffPreview.module.css'

/** Comparison reads, desktop metadata, and the native open supplied by the plugin. */
export interface DiffPreviewInjected {
  hooks: {
    changesDiff: ObservableSnapshot<ReturnType<ChangesDiffStore['state']['getSnapshot']>>
    presentedOpen: ObservableSnapshot<ReturnType<PresentedOpenController['state']['getSnapshot']>>
    presentedHost: ObservableSnapshot<ReturnType<PresentedOpenController['host']['getSnapshot']>>
  }
  loadChangesDiff: ChangesDiffStore['load']
  reloadPresentedHost: PresentedOpenController['loadHost']
  openChanged: PresentedOpenController['openChanged']
}

/** The body's composed props: the tab it draws, its injected face, and its copy. */
export type DiffPreviewProps = PropsRuntime<'sidebar.right.pane.tab'> & InjectFace<DiffPreviewInjected> & PropsLocale<typeof NS>

/** One drawn line of a hunk with its line numbers on each side. */
interface DiffRow {
  kind: 'add' | 'del' | 'context'
  old: number | undefined
  new: number | undefined
  text: string
}

/**
 * Number a hunk's lines: context lines count on both sides, deletions on the
 * old side, additions on the new side.
 * @param hunk - a served hunk.
 * @returns the rows in order.
 */
export function hunkRows(hunk: WorkspaceDiffHunk): DiffRow[] {
  let oldNo = hunk.oldStart
  let newNo = hunk.newStart
  return hunk.lines.map((line) => {
    const text = line.slice(1)
    switch (line[0]) {
      case '+': return { kind: 'add', old: undefined, new: newNo++, text }
      case '-': return { kind: 'del', old: oldNo++, new: undefined, text }
      default: return { kind: 'context', old: oldNo++, new: newNo++, text }
    }
  })
}

/** The one-line fact about a text comparison worth stating above its hunks, if any. */
function noteOf(diff: Extract<ChangesDiff, { kind: 'text' }>): 'diff.created' | 'diff.deleted' | 'diff.unchanged' | undefined {
  if (!diff.before) return 'diff.created'
  if (!diff.after) return 'diff.deleted'
  if (diff.hunks.length === 0) return 'diff.unchanged'
  return undefined
}

/**
 * The comparison type's body, registered under `sidebar.right.pane.tab` as `changes-diff`.
 * @param props - composed slot props.
 * @returns the comparison, or the state that stands in for it.
 */
export function DiffPreview({
  useTabInfo, useChangesDiff, usePresentedOpen, usePresentedHost, loadChangesDiff, reloadPresentedHost, openChanged, t,
}: DiffPreviewProps): ReactNode {
  const { tab } = useTabInfo()
  const coordinates = useMemo(() => parseChangesDiffAddress(tab.contentId), [tab.contentId])
  if (coordinates === undefined) throw new Error(`ui-deliverables: not a comparison address "${tab.contentId}"`)
  const { sessionId, seq, index } = coordinates
  const state = useChangesDiff(value => value[changesDiffUrl(sessionId, seq, index)])
  const host = usePresentedHost(value => value)
  const phase = usePresentedOpen(value => value[changedFileUrl(sessionId, seq, index)])
  useEffect(() => {
    if (state === undefined) void loadChangesDiff(sessionId, seq, index)
  }, [state, sessionId, seq, index, loadChangesDiff])
  useEffect(() => {
    if (host === null) void reloadPresentedHost()
  }, [host, reloadPresentedHost])
  const display = typeof state === 'object' ? state.display : coordinates.display
  const { directory, name } = pathPartsOf(display)
  const native = host !== null && host !== 'error' && host.available && phase !== 'nativeUnavailable'
  const opening = phase === 'opening'
  return (
    <div className={css.root} data-changes-diff data-diff-state={state === undefined ? 'loading' : typeof state === 'string' ? state : state.kind}>
      <div className={css.header}>
        <div className={css.path} title={display}>
          {directory !== '' && <span className={css.pathDirectory}>{directory}</span>}
          <span className={css.pathName}>{name}</span>
        </div>
        {native && <Button size="sm" disabled={opening} onClick={() => { void openChanged(sessionId, seq, index) }}>
          {t(phase === 'error' ? 'diff.openNativeError' : opening ? 'presented.opening' : 'diff.openNative')}
        </Button>}
      </div>
      {(state === undefined || state === 'loading') && <p className={css.status} role="status">{t('diff.loading')}</p>}
      {state === 'missing' && <p className={css.status}>{t('diff.missing')}</p>}
      {state === 'error' && <div className={css.status}>
        <span>{t('diff.error')}</span>
        <Button size="sm" onClick={() => { void loadChangesDiff(sessionId, seq, index) }}>{t('presented.retry')}</Button>
      </div>}
      {typeof state === 'object' && state.kind === 'binary' && <p className={css.status}>{t('diff.binary')}</p>}
      {typeof state === 'object' && state.kind === 'oversized' && <p className={css.status}>{t('diff.oversized')}</p>}
      {typeof state === 'object' && state.kind === 'text' && <TextDiff diff={state} t={t} />}
    </div>
  )
}

/** The hunks of a text comparison with their line numbers. */
function TextDiff({ diff, t }: { diff: Extract<ChangesDiff, { kind: 'text' }> } & PropsLocale<typeof NS>): ReactNode {
  const note = noteOf(diff)
  return (
    <div className={css.body}>
      {note !== undefined && <p className={css.note}>{t(note)}</p>}
      {diff.coarse && <p className={css.note} data-diff-coarse>{t('diff.coarse')}</p>}
      {diff.hunks.map((hunk, position) => (
        <section key={position} className={css.hunk}>
          <div className={css.hunkHeader}>{`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`}</div>
          {hunkRows(hunk).map((row, at) => (
            <div key={at} className={`${css.line} ${css[row.kind]}`} data-diff-line={row.kind}>
              <span className={css.number}>{row.old ?? ''}</span>
              <span className={css.number}>{row.new ?? ''}</span>
              <span className={css.sign}>{row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' '}</span>
              <span className={css.text}>{row.text}</span>
            </div>
          ))}
        </section>
      ))}
    </div>
  )
}
