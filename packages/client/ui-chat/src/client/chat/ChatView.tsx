// An enclosing `[data-conversation-scroll]` owns scrolling when present;
// otherwise this view owns it. Each row subscribes to one stable node key.

import { useCallback, useMemo, useRef, useState } from 'react'
import type { RenderMessageImages } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InboxState } from '@deepseek-ai/dsh-agent/types'
import {
  Button, IconChevronDownOutlineRegular, MarkdownDelegateProvider, Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatViewSlotProps, OpenFileOptions } from '../contract/slots.ts'
import type { ChatSnapshot } from '../contract/snapshot.ts'
import { PendingSteeringBubble, PendingSubmissionBubble } from './MessageItem.tsx'
import { ChatNodeList } from './StepProcessList.tsx'
import { TurnNavigator } from './TurnNavigator.tsx'
import { mergeTurnRailItems } from './turn-rail-items.ts'
import { useChatScroll } from './use-chat-scroll.ts'
import css from './ChatView.module.css'

/** Host/OS refusal text for the file-open dialog; empty throws keep a locale fallback. */
function openFailureMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error)
  return message === '' ? fallback : message
}

/**
 * Prompt-RPC identities already rendered by durable material: user/steering
 * node sources plus queue occurrences. A submission echo whose identity
 * appears here is hidden in the same render, so the echo→durable swap is
 * atomic — no duplicate, no gap — regardless of when the echo leaves the
 * session snapshot.
 */
function observedRpcIds(
  order: readonly string[],
  nodes: ChatSnapshot['nodes'],
  inbox: InboxState | undefined,
): ReadonlySet<string> {
  const observed = new Set<string>()
  for (const key of order) {
    const node = nodes.get(key)
    if (node === undefined || (node.kind !== 'user' && node.kind !== 'steering')) continue
    const source = (node.data as { readonly source?: unknown }).source as
      | { readonly kind?: unknown; readonly rpcId?: unknown }
      | undefined
    if (source?.kind === 'user' && typeof source.rpcId === 'string') observed.add(source.rpcId)
  }
  for (const { source } of [...inbox?.['next-turn'] ?? [], ...inbox?.['next-step'] ?? []]) {
    if (source.kind === 'user' && 'rpcId' in source) observed.add(source.rpcId)
  }
  return observed
}

/**
 * The chat view slot entry: pure component over the composed props; each
 * ordered business Node crosses the keyed renderer seat.
 */
export function ChatView({
  useSession, useChat, useChatNode, useChatNodeProcess, useSessions, useStore, actions, renderSlot,
  sessionId, openFile, openSkill, openExternalLink, loadOlder, loadThrough, loadImage, inspectCall, chatScroll, forkAt, fileMentions,
  useTranscriptView, useProjection, t,
}: ChatViewSlotProps) {
  const order = useChat(s => s.order)
  const nodeStore = useChat(s => s.nodes)
  // The rail's items are accumulated in the Chat snapshot, so this selector is
  // both the data and its change signal: the array identity moves only when a
  // Turn enters, leaves, or changes its preview.
  const turnNavigationItems = useChat(s => s.navigation.items())
  // Host-computed whole-log outline; the merge is view-layer only (the
  // conversation snapshot never carries projection values).
  const turnOutline = useProjection('turnOutline')
  const railItems = useMemo(
    () => mergeTurnRailItems(turnNavigationItems, turnOutline),
    [turnNavigationItems, turnOutline],
  )
  const inbox = useProjection('inbox') as unknown as InboxState | undefined
  // Workspace root off the session list row: path summaries display relative to it.
  const cwd = useSessions(s => s.byId[sessionId]?.cwd)
  const running = useSession(s => s.running)
  const openState = useSession(s => s.openState)
  const openError = useSession(s => s.openError)
  const hasMore = useSession(s => s.hasMore)
  const loadingOlder = useSession(s => s.loadingOlder)
  const transcriptMode = useTranscriptView(mode => mode)
  const compactTranscript = transcriptMode === 'compact'
  const [fileOpenError, setFileOpenError] = useState<{ path: string; message: string } | null>(null)
  const [fileOpenBusy, setFileOpenBusy] = useState(false)
  // Close/retry must ignore a settlement that started before the latest
  // gesture; otherwise a cancelled in-flight refusal reopens the dialog.
  const fileOpenRequest = useRef(0)

  const requestOpenFile = useCallback((path: string, options?: OpenFileOptions) => {
    const id = ++fileOpenRequest.current
    setFileOpenBusy(true)
    void (options === undefined ? openFile(path) : openFile(path, options)).then(
      () => {
        if (id !== fileOpenRequest.current) return
        setFileOpenError(null)
        setFileOpenBusy(false)
      },
      (error: unknown) => {
        if (id !== fileOpenRequest.current) return
        setFileOpenError({
          path,
          message: openFailureMessage(
            error,
            t('fileOpen.unknown'),
          ),
        })
        setFileOpenBusy(false)
      },
    )
  }, [openFile, t])

  const closeFileOpenError = useCallback(() => {
    fileOpenRequest.current += 1
    setFileOpenError(null)
    setFileOpenBusy(false)
  }, [])

  const pendingSteering = useMemo(
    () => inbox?.['next-step'].filter(message => message.source.kind === 'user') ?? [],
    [inbox],
  )
  const pendingSubmissions = useSession(s => s.pendingSubmissions)
  // Submission echoes still awaiting their durable counterpart. `order` is the
  // recompute trigger: durable user material always arrives as an append, and
  // every append replaces the order array.
  const visibleSubmissions = useMemo(() => {
    if (pendingSubmissions.length === 0) return pendingSubmissions
    const observed = observedRpcIds(order, nodeStore, inbox)
    return pendingSubmissions.filter(submission => (
      submission.placement !== 'queued' && !observed.has(submission.requestId)
    ))
  }, [pendingSubmissions, order, nodeStore, inbox])
  const renderMessageImages = useCallback<RenderMessageImages>(
    owner => renderSlot('conversation.message.images', { ...owner, loadImage }),
    [loadImage, renderSlot],
  )

  const firstKey = order[0]
  const firstSeq = firstKey === undefined ? null : nodeStore.get(firstKey)?.anchorSeq ?? null
  const lastKey = order.at(-1) ?? null
  const scroll = useChatScroll({
    ready: openState === 'open',
    order, firstSeq, lastKey, running, loadingOlder, hasMore, chatScroll, loadOlder, loadThrough,
    lastIsUser: lastKey !== null && nodeStore.get(lastKey)?.kind === 'user',
    steeringId: pendingSteering.at(-1)?.id ?? null,
    submissionId: visibleSubmissions.at(-1)?.requestId ?? null,
    loadedTurns: turnNavigationItems,
  })

  return (
    <div className={css.root}>
      <div ref={scroll.listRef} className={css.scroll}>
        {scroll.initialized && (
          <TurnNavigator
            items={railItems}
            activeTurn={scroll.activeTurn}
            busyTurn={scroll.busyTurn}
            onNavigate={scroll.navigateToTurn}
            t={t}
          />
        )}
        <div ref={scroll.columnRef} className={css.column} data-chat-flow="">
          {openState === 'loading' && <div className={css.hint}>{t('chat.loadingHistory')}</div>}
          {openState === 'error' && openError !== null && (
            <div className={css.openError}>
              {t('chat.loadError', { message: openError.message, code: openError.code })}
            </div>
          )}
          {hasMore && (
            <div className={css.older}>
              <button type="button" disabled={loadingOlder} onClick={scroll.loadEarlier}>
                {loadingOlder ? t('loading') : t('chat.loadOlder')}
              </button>
            </div>
          )}
          <MarkdownDelegateProvider openExternalLink={openExternalLink} openFile={requestOpenFile}>
            <ChatNodeList
              useChat={useChat}
              useChatNode={useChatNode}
              useChatNodeProcess={useChatNodeProcess}
              historyIncomplete={hasMore}
              compactTranscript={compactTranscript}
              expandedSteps={transcriptMode === 'expanded'}
              useStore={useStore}
              actions={actions}
              cwd={cwd}
              openFile={requestOpenFile}
              openSkill={openSkill}
              inspectCall={inspectCall}
              forkAt={forkAt}
              loadImage={loadImage}
              renderMessageImages={renderMessageImages}
              fileMentions={fileMentions}
              renderSlot={renderSlot}
              t={t}
            />
          </MarkdownDelegateProvider>
          {/* No pending placeholders: questions (ui-user-questions) and approvals
              (ApprovalPanel) both take over the composer, so a flow card would
              double-render the same wait. */}
          {pendingSteering.map(item => (
            <PendingSteeringBubble
              key={item.id}
              content={item.content}
              renderMessageImages={renderMessageImages}
              t={t}
            />
          ))}
          {visibleSubmissions.map(submission => (
            <PendingSubmissionBubble
              key={submission.requestId}
              submission={submission}
              renderMessageImages={renderMessageImages}
              t={t}
            />
          ))}
        </div>
        {!scroll.followingTail && (
          <div className={css.toBottomSlot}>
            <button
              type="button"
              className={css.toBottom}
              aria-label={t('chat.toBottom')}
              onClick={scroll.returnToBottom}
            >
              <IconChevronDownOutlineRegular />
            </button>
          </div>
        )}
      </div>
      {fileOpenError !== null && (
        <FileOpenErrorDialog
          message={fileOpenError.message}
          busy={fileOpenBusy}
          onClose={closeFileOpenError}
          onRetry={() => { requestOpenFile(fileOpenError.path) }}
          t={t}
        />
      )}
    </div>
  )
}

/** In-page Host open-path refusal: the wire reason plus a retry of the same path. */
function FileOpenErrorDialog({
  message, busy, onClose, onRetry, t,
}: {
  message: string
  busy: boolean
  onClose: () => void
  onRetry: () => void
  t: ChatViewSlotProps['t']
}) {
  return (
    <Modal
      open
      onClose={onClose}
      closeLabel={t('close')}
      title={t('fileOpen.title')}
      description={message}
      footer={(
        <>
          <Button variant="outline" className={css.modalAction} onClick={onClose}>{t('cancel')}</Button>
          <Button variant="primary" className={css.modalAction} disabled={busy} onClick={onRetry}>{t('retry')}</Button>
        </>
      )}
    />
  )
}
