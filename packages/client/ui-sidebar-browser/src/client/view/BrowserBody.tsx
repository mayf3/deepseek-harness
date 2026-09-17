/** Browser toolbar and Web iframe renderer. */
import { useEffect, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import {
  IconChevronLeftOutline14,
  IconChevronRightOutline14,
  IconLinkOutline14,
  IconRefreshOutline14,
  IconRightUpOutline16,
  IconShieldOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { BrowserInjected } from '../browser/BrowserController.ts'
import type { BrowserFrameState } from '../browser/BrowserFrame.ts'
import { BrowserNavigation } from '../browser/BrowserNavigation.ts'
import type { BrowserAddressFailure } from '../browser/url.ts'
import type { BrowserStore } from '../browser/store.ts'
import css from './Browser.module.css'

/** Fixed Web iframe sandbox; popups escape the sandbox while top navigation remains absent. */
export const WEB_BROWSER_SANDBOX = 'allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox'

const INITIAL_BROWSER_FRAME: BrowserFrameState = { document: undefined, sandboxed: true }

/** Browser body props assembled by the tab seat. */
export type BrowserBodyProps = PropsRuntime<'sidebar.right.pane.tab'>
  & PropsStore<BrowserStore>
  & PropsLocale<'sidebarBrowser'>
  & InjectFace<BrowserInjected>

/** Translate one parser refusal without matching display strings in logic. */
function failureText(reason: BrowserAddressFailure, t: BrowserBodyProps['t']): string {
  return t(`error.${reason}`)
}

function useBrowserDraft(
  controlledUrl: string | undefined,
  requestId: number | undefined,
): readonly [string, (value: string) => void] {
  const [edit, setEdit] = useState<{ readonly requestId: number | undefined; readonly value: string }>()
  const value = edit !== undefined && edit.requestId === requestId ? edit.value : controlledUrl ?? ''
  return [value, (draft) => { setEdit({ requestId, value: draft }) }]
}

/** Browser tab renderer for a controller-owned URL state and Web iframe carrier. */
export function BrowserBody(props: BrowserBodyProps): ReactNode {
  const {
    goBack, goForward, loadUrl, mount, reload, reportLoaded, toggleSandbox,
    useBrowserFrame, useStore, useTabInfo, t,
  } = props
  const { tab } = useTabInfo()
  const state = useStore(snapshot => snapshot.byTab[tab.id]) ?? BrowserNavigation.empty()
  const initialState = useRef(state)
  const initialUrl = useRef(tab.navigation.params?.url)
  const current = BrowserNavigation.current(state)
  const [draft, setDraft] = useBrowserDraft(current?.url, state.request?.revision)
  const [mountCount, setMountCount] = useState(0)

  useEffect(() => {
    mount(tab.id, tab.signal, window.location.origin, initialState.current)
    setMountCount(count => count + 1)
  }, [mount, tab.id, tab.signal])

  useEffect(() => {
    if (mountCount === 0) return
    const resumed = BrowserNavigation.current(initialState.current)
    if (resumed !== undefined) {
      reload(tab.id)
      return
    }
    const url = initialUrl.current
    if (url !== undefined) loadUrl(tab.id, url)
  }, [loadUrl, mountCount, reload, tab.id])

  const frameState = useBrowserFrame(tab.id) ?? INITIAL_BROWSER_FRAME
  const { document, sandboxed } = frameState

  const navigationUnknown = state.navigation.status === 'unknown'
  const externalUrl = navigationUnknown ? undefined : current?.url
  const submit = (event: FormEvent): void => { event.preventDefault(); loadUrl(tab.id, draft) }
  const failure = state.failure === undefined ? undefined : failureText(state.failure.reason, t)
  const placeholder = current === undefined
    ? t('start')
    : state.navigation.status === 'failed' ? undefined : t('loading')

  return (
    <div className={css.root}>
      <form className={css.toolbar} onSubmit={submit}>
        <button type="button" className={css.tool} aria-label={t('back')} title={t('back')} disabled={!BrowserNavigation.canGoBack(state)} onClick={() => { goBack(tab.id) }}><IconChevronLeftOutline14 /></button>
        <button type="button" className={css.tool} aria-label={t('forward')} title={t('forward')} disabled={!BrowserNavigation.canGoForward(state)} onClick={() => { goForward(tab.id) }}><IconChevronRightOutline14 /></button>
        <button type="button" className={css.tool} aria-label={t('reload')} title={t('reload')} disabled={current === undefined} onClick={() => { reload(tab.id) }}><IconRefreshOutline14 /></button>
        <div className={css.addressBox}>
          <input
            className={`${css.address} ${navigationUnknown ? css.addressUnknown : ''}`}
            value={draft}
            aria-label={t('address.placeholder')}
            placeholder={t('address.placeholder')}
            spellCheck={false}
            onChange={(event) => { setDraft(event.currentTarget.value) }}
          />
          {navigationUnknown && <span className={css.addressChanged}>{t('address.changed')}</span>}
          <button type="submit" className={`${css.tool} ${css.addressGo}`} aria-label={t('go')} title={t('go')}><IconLinkOutline14 /></button>
        </div>
        <button
          type="button"
          className={css.tool}
          aria-label={t('external')}
          title={t('external')}
          disabled={externalUrl === undefined}
          onClick={() => {
            /* v8 ignore next -- React does not dispatch clicks from this disabled button. */
            if (externalUrl !== undefined) window.open(externalUrl, '_blank', 'noopener,noreferrer')
          }}
        ><IconRightUpOutline16 size={14} /></button>
        <button
          type="button"
          className={`${css.tool} ${sandboxed ? '' : css.sandboxOff}`}
          aria-label={t(sandboxed ? 'sandbox.disable' : 'sandbox.enable')}
          title={t(sandboxed ? 'sandbox.disable' : 'sandbox.enable')}
          aria-pressed={!sandboxed}
          disabled={mountCount === 0}
          onClick={() => { toggleSandbox(tab.id) }}
        ><IconShieldOutline16 size={15} /></button>
      </form>
      {!sandboxed && <div className={css.sandboxWarning} role="status">{t('sandbox.warning')}</div>}
      {failure !== undefined && <div className={css.failure} role="alert">{failure}</div>}
      {document === undefined
        ? <div className={css.start}>{placeholder}</div>
        : <iframe
          key={`${document.target.url}:${String(document.revision)}`}
          className={css.frame}
          src={document.src}
          sandbox={sandboxed ? WEB_BROWSER_SANDBOX : undefined}
          referrerPolicy="no-referrer"
          title={document.target.title}
          onLoad={() => { reportLoaded(tab.id, document.revision) }}
          data-sidebar-browser-frame
        />}
      {navigationUnknown && <p className={css.limit}>{t('web.unknown')}</p>}
    </div>
  )
}
