/** Existing changed-file chips and explicitly delivered snapshots for a closing turn. */
import type { TurnTailOwnerProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import { LinkIcon, classifyLinkPath, fileSizeText, IconDownloadOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, SessionStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { ProducedFiles } from './ProducedFiles.tsx'
import { basename, presentedForClosing, selectProducedFiles, type PresentedPath } from './turn-deliverables.ts'
import type { NS } from './locales.ts'
import { presentedFileUrl } from '../presented.ts'
import css from './Deliverables.module.css'

interface DeliverablesMatch { produced: readonly string[]; presented: readonly PresentedPath[] }

/**
 * Claim turns containing modified paths or presented snapshots.
 * @param owner - closing turn.
 * @returns matched files, or null for an empty turn.
 */
export function selectDeliverables(owner: TurnTailOwnerProps): DeliverablesMatch | null {
  const produced = selectProducedFiles(owner) ?? []
  const presented = presentedForClosing(owner)
  return produced.length + presented.length === 0 ? null : { produced, presented }
}

/**
 * Render workspace file actions and immutable snapshot downloads.
 * @param props - matched files, workspace opener, and localized copy.
 * @returns the closing turn's file rows.
 */
export function Deliverables({ matched, openFile, t, sessionId }: Pick<TurnTailOwnerProps, 'openFile'> & {
  matched: DeliverablesMatch
} & PropsLocale<typeof NS> & Pick<SessionStandardProps, 'sessionId'>) {
  return <>
    {matched.produced.length > 0 && <ProducedFiles matched={matched.produced} openFile={openFile} t={t} />}
    {matched.presented.length > 0 && <div className={css.root}>
      <span className={css.label}>{t('presented.label')}</span>
      <div className={css.presented} data-presented-files-row>
        {matched.presented.map(file => <a key={file.path} className={css.file}
          href={presentedFileUrl(sessionId, file.seq, file.index)} download={file.name}
          title={file.path} aria-label={t('presented.download', { name: file.path })}>
          <LinkIcon kind={classifyLinkPath(file.path)} className={css.fileIcon} />
          <span className={css.details}>
            <span className={css.fileName}>{basename(file.path)}</span>
            <span className={css.metadata}>{basename(file.path).match(/\.([^.]+)$/)?.[1]?.toUpperCase() ?? t('presented.file')} · {fileSizeText(file.bytes)}</span>
            {file.description && <span className={css.description}>{file.description}</span>}
          </span>
          <span className={css.download}><IconDownloadOutline16 /><span>{t('presented.action')}</span></span>
        </a>)}
      </div>
    </div>}
  </>
}
