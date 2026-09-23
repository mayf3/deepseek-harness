/** Running Turn clock isolated from the transcript's render cycle. */
import { memo, useEffect, useRef, useState } from 'react'
import { Shimmer, ShimmerText } from '@deepseek-ai/dsh-client-ui-primitives'
import lottie from 'lottie-web/build/player/lottie_light.js'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import { formatLiveRunDuration, LIVE_RUN_CLOCK_INTERVAL_MS } from './message-chrome.ts'
import whaleTail from './whale-tail.lottie.json' with { type: 'json' }
import a11yCss from './accessibility.module.css'
import css from './ChatView.module.css'

/**
 * Show live elapsed time after the current Turn's content without announcing ticks.
 * @param props - Chat timeline selector and localized copy.
 * @returns the blue running indicator; mount only while the Session is running.
 */
export const RunningStatus = memo(function RunningStatus({ useChat, t }: Pick<ChatViewSlotProps, 'useChat' | 't'>) {
  const startTime = useChat(({ timeline }) => {
    const latest = timeline.turnOrder.at(-1)
    const turn = latest === undefined ? undefined : timeline.turns.get(latest)
    return turn?.status === 'open' ? turn.start?.time : undefined
  })
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (startTime === undefined) return
    setNow(Date.now())
    const timer = setInterval(() => { setNow(Date.now()) }, LIVE_RUN_CLOCK_INTERVAL_MS)
    return () => { clearInterval(timer) }
  }, [startTime])
  const label = startTime === undefined ? t('chat.deepDiving') : t('chat.deepDivingFor', {
    duration: formatLiveRunDuration(Math.max(1000, now - startTime), t),
  })
  return (
    <div className={css.running} data-chat-running>
      <span className={a11yCss.visuallyHidden} role="status" aria-live="polite" aria-atomic="true">{t('chat.deepDiving')}</span>
      <span className={css.runningContent}>
        <RunningWhaleTail />
        <Shimmer active>
          <span className={css.runningText}>
            {label.split(/(\d+)/).map((part, index) => (
              <ShimmerText key={index} className={/^\d+$/.test(part) ? css.runningNumber : undefined}>{part}</ShimmerText>
            ))}
          </span>
        </Shimmer>
      </span>
    </div>
  )
})

/** Loop once per two text sweeps (3s), with a 0.3s delay; hold the initial pose for reduced motion. */
function RunningWhaleTail() {
  const container = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (container.current === null) return
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
    const animation = lottie.loadAnimation({
      container: container.current,
      renderer: 'svg',
      loop: true,
      autoplay: false,
      animationData: structuredClone(whaleTail),
      rendererSettings: { focusable: false },
    })
    let playTimer: number | undefined
    const syncPlayback = () => {
      window.clearTimeout(playTimer)
      animation.goToAndStop(0, true)
      if (!reducedMotion.matches) {
        playTimer = window.setTimeout(() => { animation.play() }, 300)
      }
    }
    animation.addEventListener('DOMLoaded', syncPlayback)
    reducedMotion.addEventListener('change', syncPlayback)
    syncPlayback()
    return () => {
      window.clearTimeout(playTimer)
      reducedMotion.removeEventListener('change', syncPlayback)
      animation.removeEventListener('DOMLoaded', syncPlayback)
      animation.destroy()
    }
  }, [])
  return <span ref={container} className={css.runningIcon} aria-hidden="true" />
}
