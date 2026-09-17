import { useCallback, useEffect, useState } from 'react'
import type { RefObject } from 'react'
import { supportsHighlighting } from './highlight.ts'
import { observeViewport } from './viewport.ts'

/**
 * Activate one supported code surface when it first intersects the viewport.
 * Activation lasts for the component lifetime; browsers without
 * IntersectionObserver activate immediately.
 * @param target - Code surface whose plain rendering reserves its geometry.
 * @param lang - Optional language hint.
 * @param initiallyActive - Activate at mount on explicit reader intent without waiting for viewport delivery.
 * @returns Whether this component may build highlighted output.
 */
export function useViewportHighlighting(
  target: RefObject<Element>,
  lang: string | undefined,
  initiallyActive = false,
): boolean {
  const supported = supportsHighlighting(lang)
  const [activated, setActivated] = useState(initiallyActive)
  const activate = useCallback((visible: boolean) => { if (visible) setActivated(true) }, [])

  useEffect(() => {
    if (activated || !supported) return
    const element = target.current
    /* v8 ignore next -- React attaches the host ref before running effects. */
    if (element === null) return
    return observeViewport(element, activate)
  }, [activate, activated, supported, target])

  return activated && supported
}
