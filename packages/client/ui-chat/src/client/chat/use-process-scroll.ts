/** Capped process-group scrolling and fades over the shared follow controller. */
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type DOMAttributes, type KeyboardEvent, type RefObject } from 'react'
import { scrollMetrics, useScrollFollow } from './use-scroll-follow.ts'

interface ScrollEdges { readonly canScrollUp: boolean; readonly canScrollDown: boolean }
const AT_REST: ScrollEdges = { canScrollUp: false, canScrollDown: false }
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '])

/**
 * Observe one group's body and content without coupling its follow intent to the outer transcript.
 * @param bodyRef - capped scrolling body.
 * @param contentRef - uncapped content whose size reports growth.
 * @param open - local disclosure state.
 * @param grouped - whether the display mode retains the group's height cap.
 * @returns edge fades, DOM event bindings, and one-shot positioning for manual opening.
 */
export function useProcessScroll(
  bodyRef: RefObject<HTMLDivElement>, contentRef: RefObject<HTMLDivElement>, open: boolean, grouped: boolean,
): {
  edges: ScrollEdges
  events: Pick<DOMAttributes<HTMLDivElement>, 'onScroll' | 'onWheel' | 'onTouchStart' | 'onPointerDown' | 'onKeyDown'>
  initialize: (position: 'top' | 'bottom') => void
} {
  const follow = useScrollFollow(false, 1)
  const initialPosition = useRef<'top' | 'bottom' | null>(null)
  const [edges, setEdges] = useState<ScrollEdges>(AT_REST)
  const initialize = useCallback((position: 'top' | 'bottom') => { initialPosition.current = position }, [])
  const sync = useCallback((resized: boolean) => {
    const body = bodyRef.current
    let next = AT_REST
    if (body !== null && body.closest('[hidden], [data-group-expanded-mode]') === null) {
      let metrics = scrollMetrics(body)
      const initial = resized ? initialPosition.current : null
      if (initial !== null) {
        metrics = follow.jump(body, metrics, initial === 'bottom' ? metrics.floor : 0)
        initialPosition.current = null
      } else {
        follow.sample(metrics)
        if (resized && follow.active) metrics = follow.toBottom(body, metrics, 'smooth')
      }
      next = { canScrollUp: metrics.top > 1, canScrollDown: metrics.top < metrics.floor - 1 }
    } else follow.reset()
    setEdges(previous => previous.canScrollUp === next.canScrollUp && previous.canScrollDown === next.canScrollDown
      ? previous : next)
  }, [bodyRef, follow])
  const interrupt = useCallback(() => {
    const body = bodyRef.current
    if (body !== null && follow.animating) follow.interrupt(body, scrollMetrics(body))
  }, [bodyRef, follow])
  const events = useMemo(() => ({
    onScroll: () => { sync(false) },
    onWheel: interrupt,
    onTouchStart: interrupt,
    onPointerDown: interrupt,
    onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
      if (!event.defaultPrevented && SCROLL_KEYS.has(event.key)) interrupt()
    },
  }), [interrupt, sync])

  useLayoutEffect(() => {
    interrupt()
    follow.reset()
    if (!grouped || !open) initialPosition.current = null
  }, [follow, grouped, interrupt, open])
  useLayoutEffect(() => {
    const body = bodyRef.current
    if (body === null || !open || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => { sync(true) })
    observer.observe(body)
    if (contentRef.current !== null) observer.observe(contentRef.current)
    return () => { observer.disconnect() }
  }, [bodyRef, contentRef, open, sync])
  return { edges, events, initialize }
}
