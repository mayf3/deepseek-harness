/**
 * The text preview's body: a file's content, or the reason it is not showing.
 *
 * Two sources meet here. The standard `useResource` hook gives the file's
 * metadata — its version — and this type's
 * own store holds the content it read through its face. A Host-reported change is
 * announced, not applied: reloading under a reader would lose their place, so
 * the bar waits for a click. A failed metadata frame — the file gone, its
 * workspace unknown — takes the same bar's place over the pages already loaded,
 * with the same reload. The type's controls, viewer choice, wrap and reload, sit at the end of
 * the path row; the Sidebar's strip carries none of them.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import { IconRefreshOutline16, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TextInjected } from './face.ts'
import { failureLine } from './failure-line.ts'
import { IconWrapOutline16 } from './icons.tsx'
import { LoadingIndicator } from './LoadingIndicator.tsx'
import { hostFileOf } from './rpc.ts'
import type { TextStore } from './store.ts'
import type { DocumentContent } from './document/contract.ts'
import { matchingDocumentPreviews } from './document/registry.ts'
import type { DocumentPreviewDefinition } from './document/registry.ts'
import { DOCUMENT_LAYOUT_READY_EVENT } from './document/layout.ts'
import { PLAIN_BODY_ID } from './text/index.ts'
import { loadedPages, lastLineLoaded, scrollToLine } from './text/lines.ts'
import css from './TextPreview.module.css'

export { linesOf, loadedPages, lastLineLoaded, scrollToLine } from './text/lines.ts'
export type { LoadedPage } from './text/lines.ts'

/** Private registration inputs; the framework binds the registry source to useDocumentPreviews. */
export interface TextPreviewInjected extends TextInjected {
  readonly hooks: { readonly documentPreviews: ObservableSnapshot<readonly DocumentPreviewDefinition[]> }
}

/** The body's composed props: the tab, its navigation, the shared store and face, and copy. */
export type TextPreviewProps =
  & PropsRuntime<'sidebar.right.pane.tab'>
  & PropsRenderSlots<'sidebar.right.tab.document'>
  & PropsStore<TextStore>
  & InjectFace<TextPreviewInjected>
  & PropsLocale<'sidebarDocumentPreview'>

/**
 * The text type's body, registered under `sidebar.right.pane.tab` as `text`.
 * @param props - composed slot props.
 * @returns the content read so far with its controls, or a progress line.
 */
export function TextPreview({
  useTabInfo, useResource, useStore, actions, loadPage, reloadPages,
  loadAll, reloadAll, useDocumentPreviews, renderSlot, t,
}: TextPreviewProps): ReactNode {
  const { tab } = useTabInfo()
  const { navigation, signal } = tab
  const meta = useResource<'file'>(tab.contentId)
  const canRead = meta.status !== 'none'
  const file = useMemo(() => hostFileOf(tab.contentId), [tab.contentId])
  const state = useStore(s => s.byTab[tab.id])
  const definitions = useDocumentPreviews(value => value)
  const candidates = useMemo(() => {
    const matched = matchingDocumentPreviews(definitions, file.path)
    const fallback = definitions.find(definition => definition.id === PLAIN_BODY_ID)
    return fallback === undefined ? matched : [...matched, fallback]
  }, [definitions, file.path])
  const selected = candidates.find(candidate => candidate.id === state?.rendererId) ?? candidates[0]
  const mode = selected?.loading
  const current = (state?.mode ?? 'text-pages') === mode ? state : undefined
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const layoutRestore = useRef<{ content: unknown; scrollTop: number; pending: boolean }>({
    content: undefined, scrollTop: 0, pending: false,
  })
  if (layoutRestore.current.content !== current?.complete) {
    layoutRestore.current = {
      content: current?.complete,
      scrollTop: state?.scrollTop ?? 0,
      pending: current?.complete !== undefined,
    }
  }
  const restoreAfterDocumentLayout = useCallback((event: Event) => {
    const restore = layoutRestore.current
    if (!restore.pending) return
    const body = event.currentTarget as HTMLDivElement
    body.scrollTop = restore.scrollTop
    restore.pending = false
  }, [])
  const setBody = useCallback((body: HTMLDivElement | null) => {
    bodyRef.current?.removeEventListener(DOCUMENT_LAYOUT_READY_EVENT, restoreAfterDocumentLayout)
    bodyRef.current = body
    body?.addEventListener(DOCUMENT_LAYOUT_READY_EVENT, restoreAfterDocumentLayout)
  }, [restoreAfterDocumentLayout])
  const [menuOpen, setMenuOpen] = useState(false)
  // Every tab of this type is a `file` resource address, so its params are the
  // `file` type's; the union is narrowed on the one field read, not validated.
  const line = navigation.params !== undefined && 'line' in navigation.params ? navigation.params.line : undefined
  const pages = current?.pages
  const loaded = useMemo(() => loadedPages(pages ?? {}), [pages])
  const loadedThrough = lastLineLoaded(loaded)
  const hasContent = loaded.length > 0 || current?.complete !== undefined

  // First mount reads the first page; a body coming back to a tab with content
  // reads nothing, because the store outlives the body.
  const started = current !== undefined
  useEffect(() => {
    if (started || !canRead || mode === undefined) return
    if (mode === 'text-pages') loadPage(tab.id, file, 1, signal, meta.value?.version)
    else loadAll(tab.id, file, signal, meta.value?.version)
  }, [started, tab.id, file, signal, loadPage, loadAll, canRead, mode, meta.value?.version])

  // Come back where the reader was once there is content to scroll: on a remount,
  // and after a reload rebuilt the content. Keyed on content presence only, so a
  // scroll write never re-lands.
  useEffect(() => {
    const body = bodyRef.current
    if (hasContent && body !== null && state !== undefined) body.scrollTop = state.scrollTop
  }, [hasContent])

  // Answer a navigation once: a line the pages do not reach yet loads the next
  // page (again, until the pages cover it or the file ends); a line they hold
  // is scrolled to and marked. The store remembers the answer, so a remount
  // restores the reader's place instead.
  useEffect(() => {
    const body = bodyRef.current
    if (current === undefined || body === null || current.revision === navigation.revision) return
    if (line === undefined || mode !== 'text-pages') {
      actions.navigated(tab.id, navigation.revision)
      return
    }
    if (line > loadedThrough && !current.eof) {
      if (!current.loading && current.failure === undefined && canRead) {
        loadPage(tab.id, file, loadedThrough + 1, signal, meta.value?.version)
      }
      return
    }
    const landed = scrollToLine(body, line)
    if (!landed && line <= loadedThrough) return
    actions.navigated(tab.id, navigation.revision)
    // Recorded here as well as by the scroll event, so the store holds the
    // landing before any later navigation reads it.
    actions.scrolled(tab.id, body.scrollTop)
  }, [
    navigation.revision, line, loadedThrough, current?.eof, current?.loading, current?.failure, started,
    mode, file, canRead, meta.value?.version,
  ])

  const content = useMemo((): DocumentContent | undefined => {
    if (mode === 'bytes-complete') {
      return current?.complete === undefined ? undefined : { kind: 'bytes', data: current.complete.data }
    }
    if (current === undefined || loaded.length === 0) return undefined
    return { kind: 'text', pages: loaded, text: loaded.filter(page => page.lines > 0).map(page => page.text).join('\n'), eof: current.eof }
  }, [mode, loaded, current?.complete, current?.eof])

  if (state === undefined || selected === undefined) {
    return (
      <div className={css.status} data-textpreview-state="loading">
        {meta.status === 'none'
          ? <p className={css.statusLine}>{t('resourceUnavailable')}</p>
          : <LoadingIndicator className={css.statusLine} label={t('loading')} />}
      </div>
    )
  }
  const next = loadedThrough + 1
  const displayPath = meta.value?.absolutePath ?? current?.complete?.absolutePath ?? file.path
  const observedVersion = meta.value?.version
  const changed = current?.version !== undefined && observedVersion !== undefined
    && observedVersion !== current.version && observedVersion !== current.observedVersion
  const loadNext = (): void => {
    if (!canRead || current?.loading || current?.eof) return
    if (mode === 'text-pages') loadPage(tab.id, file, next, signal, meta.value?.version)
    else loadAll(tab.id, file, signal, meta.value?.version)
  }
  const reload = (): void => {
    if (!canRead) return
    if (mode === 'text-pages') reloadPages(tab.id, file, signal, meta.value?.version)
    else reloadAll(tab.id, file, signal, meta.value?.version)
  }
  return (
    <div className={css.preview} data-textpreview-state="text" data-textpreview-url={tab.contentId} data-document-preview={selected.id}>
      {meta.failure !== undefined
        ? (
          // The file's metadata failed — gone, or its workspace unknown — which
          // outranks a pending change; the pages already read stay under it.
          <p className={css.changed} data-textpreview-meta-failed={meta.failure.code}>
            <span>{failureLine(t, meta.failure)}</span>
            <button
              type="button"
              className={css.action}
              data-textpreview-reload-now
              onClick={reload}
            >
              {t('reloadNow')}
            </button>
          </p>
        )
        : changed && (
          <p className={css.changed} data-textpreview-changed>
            <span>{t('changed')}</span>
            <button
              type="button"
              className={css.action}
              data-textpreview-reload-now
              onClick={reload}
            >
              {t('reloadNow')}
            </button>
          </p>
        )}
      <div className={css.header}>
        <div className={css.path} title={displayPath} data-textpreview-path>{displayPath}</div>
        <Menu
          open={menuOpen}
          anchor={(
            <button type="button" className={clsx(css.tool, css.viewerTool)} aria-label={t('openWith')} title={selected.title()} data-document-viewer-menu onClick={() => { setMenuOpen(value => !value) }}>
              {selected.title()}
            </button>
          )}
          items={candidates.map(candidate => ({ id: candidate.id, label: candidate.title() }))}
          selectedId={selected.id}
          onSelect={(id) => { actions.selected(tab.id, id); setMenuOpen(false) }}
          onClose={() => { setMenuOpen(false) }}
          align="end"
          portal
          dense
        />
        {selected.wrap === true && (
          <button
            type="button"
            className={clsx(css.tool, state.wrap && css.toolOn)}
            aria-pressed={state.wrap}
            aria-label={t('wrap')}
            title={t('wrap')}
            data-textpreview-tool="wrap"
            onClick={() => { actions.toggledWrap(tab.id) }}
          >
            <IconWrapOutline16 />
          </button>
        )}
        <button
          type="button"
          className={css.tool}
          aria-label={t('reload')}
          title={t('reload')}
          data-textpreview-tool="reload"
          onClick={reload}
        >
          <IconRefreshOutline16 />
        </button>
      </div>
      <div
        ref={setBody}
        className={clsx(css.body, state.wrap && css.wrap)}
        data-textpreview-body
        data-textpreview-wrap={state.wrap ? '' : undefined}
        onScroll={(event) => {
          const body = event.currentTarget
          actions.scrolled(tab.id, body.scrollTop)
          if (mode === 'text-pages' && current?.failure === undefined && body.clientHeight > 0
            && body.scrollTop + body.clientHeight >= body.scrollHeight - 1) loadNext()
        }}
      >
        {!hasContent && current?.failure === undefined && (
          <LoadingIndicator className={css.statusLine} label={t('loading')} />
        )}
        {content !== undefined && renderSlot('sidebar.right.tab.document', {
          resourceAddress: tab.contentId, content, wrap: state.wrap,
        }, {
          entryKey: selected.id, hookContext: useTabInfo,
          fallback: <p className={css.statusLine}>{t('rendererUnavailable', { name: selected.title() })}</p>,
        })}
        {current?.failure !== undefined && (
          <p className={css.statusLine} data-textpreview-failed={current.failure.code}>
            <span>{failureLine(t, current.failure)}</span>
            <button
              type="button"
              className={css.action}
              data-textpreview-retry
              onClick={loadNext}
            >
              {t('retry')}
            </button>
          </p>
        )}
        {mode === 'text-pages' && current !== undefined && loaded.length > 0 && !current.eof && current.failure === undefined && (
          <button
            type="button"
            className={css.more}
            disabled={current.loading}
            data-textpreview-more
            onClick={loadNext}
          >
            {current.loading ? <LoadingIndicator label={t('loading')} /> : t('loadMore')}
          </button>
        )}
      </div>
    </div>
  )
}
