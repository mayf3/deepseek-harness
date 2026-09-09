/** File identity and explicit default-app or file-manager actions for one delivery. */
import { useState } from 'react'
import { relativizeToCwd, resolveWorkspacePath } from '@deepseek-ai/dsh-util-workspace-path'
import {
  Button, Menu, LinkIcon, classifyLinkPath, IconRightUpOutline16,
  IconChevronDownOutline14, IconFolderOpenOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { PresentedAction, PresentedHost } from '../presented.ts'
import type { PresentedOpenPhase } from './present-open.ts'
import { basename, type PresentedPath } from './turn-deliverables.ts'
import type { NS } from './locales.ts'
import css from './Deliverables.module.css'

/**
 * Render independent file actions without nesting buttons inside a clickable card.
 * @param props - durable file metadata, Session workspace root, Host capabilities, gesture status, and localized copy.
 * @returns the file card and its anchored action menu.
 */
export function PresentedFileCard({ file, cwd, phase, host, onAction, t }: {
  file: PresentedPath
  cwd: string | undefined
  phase: PresentedOpenPhase | undefined
  host: PresentedHost | null
  onAction: (action: PresentedAction) => void
} & PropsLocale<typeof NS>) {
  const [menuOpen, setMenuOpen] = useState(false)
  const pending = phase === 'opening' || phase === 'revealing'
  const disabled = pending || host === null || !host.available
  const reveal = host?.fileManager ?? 'directory'
  const act = (action: PresentedAction) => { setMenuOpen(false); onAction(action) }
  const description = (title: string, detail: string) => <span className={css.menuLabel}>
    <span>{title}</span><span className={css.menuDetail}>{detail}</span>
  </span>
  return <div className={css.file} data-presented-file>
    <div className={css.heading}>
      <span className={css.fileIcon}><LinkIcon kind={classifyLinkPath(file.path)} /></span>
      <div className={css.details}>
        <div className={css.nameRow}>
          <span className={css.fileName}>{basename(file.path)}</span>
          <span className={css.metadata}>{basename(file.path).match(/\.([^.]+)$/)?.[1]?.toUpperCase() ?? t('presented.file')}</span>
        </div>
        {file.description && <span className={css.description}>{file.description}</span>}
      </div>
    </div>
    <div className={css.footer}>
      <span className={css.path} title={resolveWorkspacePath(cwd, file.path)}>
        <IconFolderOpenOutline16 /><span>{relativizeToCwd(file.path, cwd)}</span>
      </span>
      <div className={css.split}>
        <Button segment="start" className={css.open} icon={<IconRightUpOutline16 />} disabled={disabled}
          aria-label={t('presented.open', { name: file.path })} onClick={() => { act('open') }}>
          {t('presented.action')}
        </Button>
        <Menu open={menuOpen && !disabled} autoFocus portal align="end" onClose={() => { setMenuOpen(false) }}
          anchor={<Button segment="end" className={css.chevron} disabled={disabled}
            aria-haspopup="menu" aria-expanded={menuOpen && !disabled}
            aria-label={t('presented.more', { name: file.path })}
            onClick={() => { setMenuOpen(value => !value) }}><IconChevronDownOutline14 /></Button>}
          items={[
            { type: 'label', id: 'host', text: t('presented.host', { name: host?.name ?? '' }) },
            { id: 'open', icon: <IconRightUpOutline16 />,
              label: description(t('presented.defaultApp'), t('presented.openDetail')) },
            { type: 'separator', id: 'separator' },
            { id: 'reveal', icon: <IconFolderOpenOutline16 />,
              label: description(t(`presented.${reveal}`), t(reveal === 'directory' ? 'presented.directoryDetail' : 'presented.revealDetail')) },
          ]}
          onSelect={(id) => { act(id === 'reveal' ? 'reveal' : 'open') }} />
      </div>
    </div>
    {phase !== undefined && <span className={css.description} role="status">
      {t(phase === 'revealed' && reveal === 'directory' ? 'presented.directoryOpened' : `presented.${phase}`)}
    </span>}
  </div>
}
