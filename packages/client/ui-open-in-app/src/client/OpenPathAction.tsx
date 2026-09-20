/**
 * Document-header split button: the main button opens the previewed file in
 * its default application, the chevron's menu adds the file-manager reveal.
 * Both path controls share the gesture hook declared here.
 */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  IconChevronDownOutlineRegular, IconFolderOpenOutlineRegular, IconRightUpOutlineRegular, Menu, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionWorkspacePathApplication } from '@deepseek-ai/dsh-api-session-controller/types'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'
import type { OpenInAppPathAction, OpenInAppPathFailure } from './open-path.ts'
import { useOpenFailureToast } from './open-failure-toast.tsx'
import type { NS } from './locales.ts'
import css from './OpenPathAction.module.css'

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

/** What one path control needs from its props: the file, the injected face, and copy. */
type PathGestureProps = Pick<OpenPathActionProps, 'absolutePath' | 'useOpenInAppDesktop' | 'loadDesktop' | 'openPath'> & {
  t: TranslateNS<typeof NS>
}

/**
 * Desktop availability, this control's own pending state, and a gesture
 * runner announcing failures through this control's toast. Only the control
 * that ran the gesture disables while it settles; failure never persists on
 * the control.
 * @param props - the file's Host path, the injected face, and copy.
 * @returns availability, pending, the toast to render, and the runner.
 */
export function usePathGesture({ absolutePath, useOpenInAppDesktop, loadDesktop, openPath, t }: PathGestureProps): {
  available: boolean
  pending: boolean
  toast: ReactNode
  act: (action: OpenInAppPathAction, application?: string) => void
} {
  const desktop = useOpenInAppDesktop(value => value)
  const [pending, setPending] = useState(false)
  const inFlight = useRef(false)
  const { toast, show } = useOpenFailureToast()
  useEffect(() => {
    if (desktop === null) void loadDesktop()
  }, [desktop, loadDesktop])
  return {
    available: desktop === true,
    pending,
    toast,
    act: (action, application) => {
      if (inFlight.current) return
      inFlight.current = true
      setPending(true)
      void openPath(absolutePath, action, application).then((failure) => {
        if (failure !== null) show(t(`path.${failure}`))
      }).finally(() => { inFlight.current = false; setPending(false) })
    },
  }
}

/**
 * Render the split button, or nothing until the Host reports a desktop.
 * @param props - the previewed file, the injected face, and copy.
 * @returns the split button with its menu and toast, or null.
 */
export function OpenPathAction(props: OpenPathActionProps): ReactNode {
  const { t } = props
  const [menuOpen, setMenuOpen] = useState(false)
  const { available, pending, toast, act } = usePathGesture(props)
  const [association, setAssociation] = useState<{
    path: string
    apps: readonly SessionWorkspacePathApplication[] | null
  } | null>(null)
  useEffect(() => {
    if (!available) return
    const controller = new AbortController()
    void props.applications(props.absolutePath, controller.signal).then((apps) => {
      if (!controller.signal.aborted) setAssociation({ path: props.absolutePath, apps })
    })
    return () => { controller.abort() }
  }, [available, props.absolutePath, props.applications, menuOpen])
  const apps = association?.path === props.absolutePath ? association.apps : null
  const preferred = apps?.find(app => app.default)
  if (!available) return null
  const run = (action: OpenInAppPathAction, application?: string): void => {
    setMenuOpen(false)
    act(action, application)
  }
  return (
    <>
      <Menu
        className={css.menuAnchor}
        open={menuOpen && !pending}
        autoFocus
        portal
        dense
        align="end"
        onClose={() => { setMenuOpen(false) }}
        items={[
          { id: 'open', icon: <IconRightUpOutlineRegular />, label: t('path.defaultApp') },
          ...(apps ?? []).map(app => ({
            id: `app:${app.id}`,
            icon: app.icon === null ? <IconRightUpOutlineRegular /> : <img src={app.icon} className={css.appIcon} alt="" />,
            label: app.default ? t('path.appDefault', { app: app.name }) : app.name,
          })),
          ...(association?.path === props.absolutePath && apps === null
            ? [{ id: 'unavailable', label: t('path.appsError'), disabled: true }] : []),
          { id: 'reveal', icon: <IconFolderOpenOutlineRegular />, label: t('path.reveal') },
        ]}
        onSelect={(id) => {
          if (id.startsWith('app:')) run('open', id.slice(4))
          else run(id === 'reveal' ? 'reveal' : 'open')
        }}
        anchor={(
          <div className={css.split} data-open-path data-state={pending ? 'busy' : 'idle'}>
            <Tooltip label={t('path.open.tooltip')} side="bottom" delayMs={500}>
              <button
                type="button"
                className={css.main}
                disabled={pending}
                data-open-path-open
                onClick={() => { run('open') }}
              >
                {preferred?.icon != null && <img src={preferred.icon} className={css.appIcon} alt="" />}
                {t('path.open')}
              </button>
            </Tooltip>
            <button
              type="button"
              className={css.chevron}
              disabled={pending}
              aria-haspopup="menu"
              aria-expanded={menuOpen && !pending}
              aria-label={t('path.more')}
              data-open-path-more
              onClick={() => { setMenuOpen(value => !value) }}
            >
              <IconChevronDownOutlineRegular size={11} />
            </button>
          </div>
        )}
      />
      {toast}
    </>
  )
}
