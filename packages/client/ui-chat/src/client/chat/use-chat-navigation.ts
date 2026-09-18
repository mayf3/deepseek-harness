/** Turn jumps and history-prepend anchoring, independent of DOM measurement. */
import { useLayoutEffect, useState } from 'react'
import type { SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { ChatNode } from '../contract/chat-nodes.ts'
import type { ChatScrollPosition, ChatViewSlotProps } from '../contract/slots.ts'
import type { TurnRailItem } from './turn-rail-items.ts'
import type { ChatReading, ReadingSample } from './use-chat-reading.ts'
import type { ChatViewport } from './use-chat-viewport.ts'

/** History availability and loading operations for the committed Chat window. */
export interface ChatNavigationInput extends Pick<ChatViewSlotProps, 'loadOlder' | 'loadThrough'> {
  readonly firstSeq: ChatNode['anchorSeq'] | null
  readonly hasMore: boolean
  readonly loadingOlder: boolean
}

interface TurnJump {
  readonly turn: number
  readonly seq: SessionSeq
  phase: 'loading' | 'settled'
  landing: 'pending' | 'landed' | 'interrupted'
  repageHead: ChatNavigationInput['firstSeq']
}

/** Owns one replaceable turn jump and the anchor retained while history loads. */
export class ChatNavigation {
  private jump: TurnJump | null = null
  private anchor: ChatScrollPosition | null = null
  private committed: Pick<ChatNavigationInput, 'firstSeq' | 'loadingOlder'>
  private settleFrame: number | null = null

  constructor(
    private readonly viewport: ChatViewport,
    private readonly reading: ChatReading,
    private input: ChatNavigationInput,
    private readonly onBusyTurn: (turn: number | null) => void,
  ) {
    this.committed = input
  }

  /**
   * Adopt committed history availability without starting a request.
   * @param input - history state from the latest committed render.
   */
  setInput(input: ChatNavigationInput): void { this.input = input }

  /** Cancel navigation and establish the current history window as the baseline. */
  reset(): void {
    this.cancel()
    this.committed = this.input
  }

  /** Cancel local callbacks; late history completions cannot revive a task. */
  dispose(): void {
    this.clearTask()
  }

  /** Release the jump, paging anchor, and busy indicator without cancelling shared history I/O. */
  cancel(): void {
    this.clearTask()
    this.onBusyTurn(null)
  }

  private clearTask(): void {
    this.cancelFrame()
    this.jump = null
    this.anchor = null
  }

  /**
   * Replace the current jump with an explicit turn selection.
   * @param item - loaded anchor or unloaded turn to fetch before landing.
   */
  readonly navigateToTurn = (item: TurnRailItem): void => {
    if (item.anchor.kind === 'loaded') {
      const landing = this.viewport.scrollToTurn(item.turn)
      if (landing === null) return
      this.cancel()
      this.reading.acceptNavigation(landing)
      this.anchor = this.input.loadingOlder ? landing.position : null
      return
    }
    this.cancelFrame()
    this.anchor = this.viewport.capturePosition()
    this.reading.pauseFollowing()
    const jump: TurnJump = {
      turn: item.turn,
      seq: item.anchor.seq,
      phase: 'loading',
      landing: 'pending',
      repageHead: null,
    }
    this.jump = jump
    this.onBusyTurn(jump.turn)
    this.request(jump)
  }

  /** Request one older page while retaining the current semantic position. */
  readonly loadEarlier = (): void => {
    this.anchor = this.viewport.capturePosition()
    this.input.loadOlder()
  }

  /**
   * Preserve reader ownership across pending history work.
   * @param sample - settled reader movement that can update or interrupt an anchor.
   */
  readerSampled(sample: ReadingSample): void {
    if (sample.movedByReader && this.jump?.landing === 'landed') this.jump.landing = 'interrupted'
    if (sample.followingTail) this.anchor = null
    else if (this.anchor !== null && sample.position !== null) this.anchor = sample.position
  }

  /**
   * Reconcile a newly committed history head with any retained anchor.
   * @returns whether a prepended window consumed the current position-preservation operation.
   */
  contentCommitted(): boolean {
    const previous = this.committed
    this.committed = this.input
    if (this.anchor !== null && this.input.firstSeq !== null && previous.firstSeq !== null
      && this.input.firstSeq < previous.firstSeq) {
      if (this.landJump(false)) return true
      const landing = this.viewport.preserve(this.anchor)
      this.anchor = this.jump === null ? null : landing?.position ?? null
      if (landing !== null) this.reading.preservePosition(landing)
      return true
    }
    if (previous.loadingOlder && !this.input.loadingOlder && this.jump === null) this.anchor = null
    return false
  }

  /** Land, retry, or complete the current jump against the committed window. */
  reconcile(): void {
    const jump = this.jump
    if (jump === null || this.reading.pending) return
    if (jump.phase === 'loading') {
      if (jump.landing === 'pending') this.landJump(false)
      return
    }
    if (this.input.loadingOlder) return
    if (this.landJump(true)) return
    const uncovered = this.input.firstSeq === null || this.input.firstSeq > jump.seq
    if (uncovered && this.input.hasMore && jump.repageHead !== this.input.firstSeq) {
      jump.repageHead = this.input.firstSeq
      this.anchor = this.viewport.capturePosition()
      this.request(jump)
      return
    }
    const fallback = this.viewport.scrollToTurnAtOrAfter(jump.turn)
    this.cancel()
    if (fallback !== null) this.reading.acceptNavigation(fallback)
  }

  private landJump(settle: boolean): boolean {
    const jump = this.jump
    if (jump === null) return false
    if (jump.landing === 'interrupted') {
      if (settle) { this.cancel(); return true }
      return false
    }
    const landing = this.viewport.scrollToTurn(jump.turn)
    if (landing === null) return false
    this.reading.acceptNavigation(landing)
    if (settle) this.cancel()
    else {
      this.anchor = landing.position
      jump.landing = 'landed'
    }
    return true
  }

  private request(jump: TurnJump): void {
    jump.phase = 'loading'
    const settled = (): void => {
      if (this.jump !== jump) return
      jump.phase = 'settled'
      this.cancelFrame()
      if (typeof requestAnimationFrame !== 'function') this.reconcile()
      else this.settleFrame = requestAnimationFrame(() => {
        this.settleFrame = null
        if (this.jump === jump) this.reconcile()
      })
    }
    void this.input.loadThrough(jump.seq).then(settled, settled)
  }

  private cancelFrame(): void {
    if (this.settleFrame !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.settleFrame)
    this.settleFrame = null
  }
}

/**
 * Retain one navigation owner for the component's lifetime.
 * @param viewport - turn-aware DOM operations.
 * @param reading - reading and follow policy receiving navigation landings.
 * @param input - committed history state and load operations.
 * @returns the navigation owner and its visible busy turn.
 */
export function useChatNavigation(
  viewport: ChatViewport, reading: ChatReading, input: ChatNavigationInput,
): { navigation: ChatNavigation; busyTurn: number | null } {
  const [busyTurn, setBusyTurn] = useState<number | null>(null)
  const [navigation] = useState(() => new ChatNavigation(viewport, reading, input, setBusyTurn))
  useLayoutEffect(() => { navigation.setInput(input) }, [navigation, input])
  useLayoutEffect(() => () => { navigation.dispose() }, [navigation])
  return { navigation, busyTurn }
}
