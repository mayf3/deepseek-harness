import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { APP_LABEL_KEY } from './applications.ts'
import type { OpenInAppLaunchState } from './controller.ts'
import type { ShortcutCatalogEntry } from '@deepseek-ai/dsh-client-shortcuts/client'
import { NS } from './locales.ts'
import { OpenTargetButton } from './OpenTargetButton.tsx'

/** Browser operations and state shared by the Session header and file tree contributions. */
export interface OpenInAppActionInjected {
  hooks: {
    openInAppApps: ObservableSnapshot<readonly string[] | null>
    openInAppChoice: ObservableSnapshot<string>
    openInAppLaunch: ObservableSnapshot<OpenInAppLaunchState>
    shortcuts: ObservableSnapshot<readonly ShortcutCatalogEntry[]>
  }
  launch: (appId: string, path: string) => Promise<void>
  choose: (appId: string) => void
  iconUrl: (appId: string) => string
}

/** Full props for the Session-header directory split button. */
export type OpenInAppActionProps =
  PropsRuntime<'conversation.session.header.utilities'>
  & PropsLocale<typeof NS>
  & InjectFace<OpenInAppActionInjected>

/** Full props for a directory split button targeting the file tree's displayed path. */
export type DirectoryOpenInAppActionProps =
  PropsRuntime<'sidebar.right.tab.files.actions'>
  & PropsLocale<typeof NS>
  & InjectFace<OpenInAppActionInjected>

/**
 * Open the Session header's workspace through the shared directory control.
 * @param props - Session state, installed catalog, and launch operations.
 * @returns the directory control, or null without a workspace.
 */
export function OpenInAppAction(props: OpenInAppActionProps): React.JSX.Element | null {
  const cwd = props.useSessions(state => state.byId[props.sessionId]?.cwd)
  return cwd === undefined || cwd === '' ? null : <DirectoryOpenInAppAction {...props} absolutePath={cwd} />
}

/**
 * Adapt the installed directory catalog to the shared opening control.
 * @param props - displayed directory, installed catalog, and launch operations.
 * @returns the shared control, or null without an eligible application.
 */
export function DirectoryOpenInAppAction(props: DirectoryOpenInAppActionProps): React.JSX.Element | null {
  const { absolutePath, useOpenInAppApps, useOpenInAppChoice, t } = props
  const available = useOpenInAppApps(apps => apps)
  const choice = useOpenInAppChoice(id => id)
  const operation = props.useOpenInAppLaunch(value => value)
  const shortcut = props.useShortcuts(rows => rows.find(row => row.id === 'workspace.openLocal'))
  const apps = (available ?? []).flatMap((id) => {
    const key = APP_LABEL_KEY[id]
    return key === undefined ? [] : [{ id, name: t(key), icon: props.iconUrl(id) }]
  })
  const preferred = apps.find(app => app.id === choice) ?? apps[0]
  if (preferred === undefined) return null
  return (
    <OpenTargetButton
      key={absolutePath} kind="directory" applications={apps} defaultId={preferred.id} failed={false} t={t}
      busy={operation.phase === 'busy'} shortcut={shortcut}
      execute={async (operation) => {
        const id = operation.kind === 'application' ? operation.id : preferred.id
        try {
          await props.launch(id, absolutePath)
        } catch (_error) {
          // Native launch failure is announced by the shared control.
          return 'openError'
        }
        if (operation.kind === 'application') props.choose(id)
        return null
      }}
    />
  )
}
