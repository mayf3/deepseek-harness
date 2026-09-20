/** File association adapter for the shared file/directory opening control. */
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { SessionWorkspacePathApplication } from '@deepseek-ai/dsh-api-session-controller/types'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'
import type { OpenInAppPathAction, OpenInAppPathFailure } from './open-path.ts'
import { OpenTargetButton } from './OpenTargetButton.tsx'
import type { NS } from './locales.ts'

/** Desktop availability and the gesture carrier injected into both path controls. */
export interface OpenPathInjected {
  hooks: {
    openInAppDesktop: ObservableSnapshot<boolean | null>
  }
  loadDesktop: () => Promise<void>
  openPath: (path: string, action: OpenInAppPathAction, application?: string) => Promise<OpenInAppPathFailure | null>
  applications: (path: string, signal: AbortSignal) => Promise<readonly SessionWorkspacePathApplication[] | null>
}

/** Full props of the document-header contribution. */
export type OpenPathActionProps =
  PropsRuntime<'sidebar.right.tab.document.actions'>
  & PropsLocale<typeof NS>
  & InjectFace<OpenPathInjected>

/** File inputs shared by the document header and its unpreviewable state. */
type FileOpenTargetProps = Pick<OpenPathActionProps, 'absolutePath' | 'useOpenInAppDesktop' | 'loadDesktop' | 'openPath' | 'applications' | 't'> & {
  empty?: boolean
}

/**
 * Resolve file associations and adapt operations without embedding platform behavior in the control.
 * @param props - verified file path, desktop query, native operations, and display variant.
 * @returns the shared opening control, or null without a desktop.
 */
export function FileOpenTarget(props: FileOpenTargetProps): ReactNode {
  const desktop = props.useOpenInAppDesktop(value => value)
  const [revision, setRevision] = useState(0)
  const [association, setAssociation] = useState<{
    path: string
    apps: readonly SessionWorkspacePathApplication[] | null
  } | null>(null)
  useEffect(() => {
    if (desktop === null) void props.loadDesktop()
  }, [desktop, props.loadDesktop])
  useEffect(() => {
    if (desktop !== true) return
    const controller = new AbortController()
    void props.applications(props.absolutePath, controller.signal).then((apps) => {
      if (!controller.signal.aborted) setAssociation({ path: props.absolutePath, apps })
    })
    return () => { controller.abort() }
  }, [desktop, props.absolutePath, props.applications, revision])
  if (desktop !== true) return null
  const apps = association?.path === props.absolutePath ? association.apps : null
  return (
    <OpenTargetButton
      key={props.absolutePath} kind="file" applications={apps ?? []} defaultId={apps?.find(app => app.default)?.id}
      failed={association?.path === props.absolutePath && apps === null} empty={props.empty} t={props.t}
      refresh={() => { setRevision(value => value + 1) }}
      execute={operation => props.openPath(props.absolutePath, operation.kind === 'reveal' ? 'reveal' : 'open',
        operation.kind === 'application' ? operation.id : undefined)}
    />
  )
}

/**
 * Render the file adapter in the document header.
 * @param props - document owner inputs and injected opening capabilities.
 * @returns the shared split button.
 */
export function OpenPathAction(props: OpenPathActionProps): ReactNode {
  return <FileOpenTarget {...props} />
}
