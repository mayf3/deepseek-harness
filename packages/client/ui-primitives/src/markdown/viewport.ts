/** Shared viewport observation for deferred code and diagram work. */

let observer: IntersectionObserver | undefined
const listeners = new Map<Element, (visible: boolean) => void>()

/**
 * Observe visibility until disposal; unsupported browsers activate immediately.
 * @param element - Stable surface whose geometry remains available while work is deferred.
 * @param changed - Receives intersection changes, including exits.
 * @returns A disposer that releases the shared observer after the last surface leaves.
 */
export function observeViewport(element: Element, changed: (visible: boolean) => void): () => void {
  if (typeof IntersectionObserver === 'undefined') {
    changed(true)
    return () => {}
  }
  observer ??= new IntersectionObserver((entries) => {
    for (const entry of entries) listeners.get(entry.target)?.(entry.isIntersecting)
  })
  listeners.set(element, changed)
  observer.observe(element)
  return () => {
    listeners.delete(element)
    observer?.unobserve(element)
    if (listeners.size > 0) return
    observer?.disconnect()
    observer = undefined
  }
}
