import { Fragment, memo, useCallback, useEffect, useMemo, useState } from 'react'
import { JsonBlock } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConversationLocationDataStore, ConversationTurnDataMap } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatNodeOwnerProps, ChatViewSlotProps } from '../contract/slots.ts'
import type { ChatNode } from '../contract/chat-nodes.ts'
import { TURN_PROCESS_INDEPENDENT_KINDS, turnProcessAlwaysOpen } from '../contract/turn-process.ts'
import { storedTurnProcessEntry } from '../stores.ts'
import { useSearchableHidden } from './searchable-hidden.ts'
import css from './ChatView.module.css'

interface ChatNodeSeatProps extends ChatNodeOwnerProps {
  readonly assistantPart?: 'reasoning' | 'response'
  readonly nodeKey: string
  readonly useChatNode: ChatViewSlotProps['useChatNode']
  readonly useChatNodeProcess: ChatViewSlotProps['useChatNodeProcess']
  readonly historyIncomplete: boolean
  readonly compactTranscript: boolean
  readonly useStore: ChatViewSlotProps['useStore']
  readonly actions: ChatViewSlotProps['actions']
  readonly renderSlot: ChatViewSlotProps['renderSlot']
  readonly t: ChatViewSlotProps['t']
}

type RoutedChatNodeOwner = {
  [Kind in ChatNode['kind']]: ChatNodeOwnerProps & { readonly node: ChatNode<Kind> }
}[ChatNode['kind']]

function turnDataOf(node: ChatNode | undefined): ConversationLocationDataStore<ConversationTurnDataMap> | undefined {
  const location = node?.location
  return location?.kind === 'turn' || location?.kind === 'step' ? location.turn.data : undefined
}

function turnOf(node: ChatNode | undefined): number | undefined {
  const location = node?.location
  return location?.kind === 'turn' || location?.kind === 'step' ? location.turn.turn : undefined
}

/** Subscribe, apply Turn-process visibility, and dispatch one stable Context key. */
export const ChatNodeSeat = memo(function ChatNodeSeat({
  nodeKey, assistantPart, useChatNode, useChatNodeProcess, historyIncomplete, compactTranscript,
  cwd, openFile, openSkill, inspectCall, forkAt,
  loadImage, renderMessageImages, fileMentions, useStore, actions, renderSlot, t,
}: ChatNodeSeatProps) {
  const sourceNode = useChatNode(nodeKey)
  const node = useMemo(() => {
    const value = sourceNode as ChatNode | undefined
    if (value?.kind !== 'assistant-step' || assistantPart === undefined) return sourceNode
    return { ...value, data: { ...value.data, blocks: value.data.blocks.filter(block =>
      assistantPart === 'reasoning' ? block.kind === 'reasoning' : block.kind !== 'reasoning'),
    } }
  }, [sourceNode, assistantPart])
  const routedNode = node as ChatNode | undefined
  const turn = turnOf(routedNode)
  const processPresentation = useChatNodeProcess(nodeKey)
  const processSpec = processPresentation?.spec
  const storedEntry = useStore(state => processSpec === undefined
    ? undefined
    : storedTurnProcessEntry(state, processSpec.turn))
  const processEntry = processSpec !== undefined
    && storedEntry?.answerStep === (processSpec.answerStep ?? 0)
    ? storedEntry
    : undefined
  const liveProcess = processPresentation !== undefined && !processPresentation.turnClosed
  const alwaysOpen = liveProcess || turnProcessAlwaysOpen(routedNode)
  const processOpen = alwaysOpen || processEntry !== undefined
  const setOpen = useCallback((open: boolean) => {
    if (processSpec !== undefined && !alwaysOpen) {
      actions.setTurnProcessOpen(processSpec.turn, (processSpec.answerStep ?? 0), open)
    }
  }, [actions, processSpec, alwaysOpen])
  const processWindowReady = processSpec !== undefined
    && processPresentation !== undefined
    && compactTranscript
    && processPresentation.turn === processSpec.turn
    && (!historyIncomplete || processPresentation.turnStarted)
  const processMember = routedNode !== undefined
    && processWindowReady
    && !TURN_PROCESS_INDEPENDENT_KINDS.has(routedNode.kind)
    && routedNode.anchorSeq >= processSpec.processStartSeq
    && (liveProcess || processSpec.answerAnchorSeq === null || routedNode.anchorSeq < processSpec.answerAnchorSeq)
  const processAnswer = routedNode !== undefined
    && processWindowReady
    && !liveProcess
    && routedNode.kind === 'assistant-step'
    && routedNode.data.step === processSpec.answerStep
  const ownsDisclosure = routedNode?.kind === 'turn-process' || processAnswer
  const foldable = processWindowReady
    && (liveProcess || processMember || ownsDisclosure)
  const turnProcess = useMemo(() => processSpec === undefined
    ? undefined
    : {
      spec: processSpec,
      foldable,
      hasContent: processPresentation?.hasExternalProcess === true || processSpec.inlineReasoning,
      open: processOpen,
      setOpen,
    }, [
    foldable, processOpen, processSpec, processPresentation?.hasExternalProcess, setOpen,
  ])
  const controllerInactive = routedNode?.kind === 'turn-process'
    && !foldable
  const compactAnswer = processAnswer
    && foldable
    && processPresentation.compactAnswer
    && !processOpen
  const processHidden = controllerInactive || (foldable && processMember && !processOpen)
  const revealProcess = useCallback(() => {
    if (processMember) setOpen(true)
  }, [processMember, setOpen])
  const wrapperRef = useSearchableHidden(processHidden, revealProcess)
  const [disclosureReset, setDisclosureReset] = useState(0)
  useEffect(() => {
    if (processMember && processHidden && wrapperRef.current?.hasAttribute('hidden')) {
      setDisclosureReset(value => value + 1)
    }
  }, [processMember, processHidden, wrapperRef])
  const owner = useMemo<ChatNodeOwnerProps | null>(() => node === undefined
    ? null
    : {
      cwd,
      openFile,
      openSkill,
      inspectCall,
      forkAt,
      loadImage,
      renderMessageImages,
      fileMentions,
      turnProcess,
    }, [
    node, cwd, openFile, openSkill, inspectCall, forkAt,
    loadImage, renderMessageImages, fileMentions, turnProcess,
  ])
  if (routedNode === undefined || owner === null) return null
  const turnData = turnDataOf(routedNode)
  // Runtime dispatch owns the correlation: every Node's discriminant is the
  // keyed-slot entry passed alongside that same Node. TypeScript does not
  // distribute an object containing a union into a union of objects itself.
  const routedOwner = { ...owner, node: routedNode } as RoutedChatNodeOwner
  return (
    <div
      ref={wrapperRef}
      className={css.flowItem}
      data-chat-anchor-key={assistantPart === 'reasoning' ? `${routedNode.key}:reasoning` : routedNode.key}
      data-chat-flow-key={routedNode.key}
      data-chat-flow-kind={routedNode.kind}
      data-chat-turn={turn}
      data-turn-process-member={processMember || undefined}
      data-turn-process-hidden={processHidden || undefined}
      data-turn-process-answer={compactAnswer || undefined}
    >
      <Fragment key={disclosureReset}>
        {renderSlot('conversation.chat.node', routedOwner, {
          entryKey: routedNode.kind,
          hookContext: turnData,
          fallback: (
            <JsonBlock
              label={t('message.unknownSurface', { type: routedNode.kind })}
              payload={routedNode.data}
              truncatedLabel={total => t('json.truncated', { total })}
            />
          ),
        })}
      </Fragment>
    </div>
  )
})
