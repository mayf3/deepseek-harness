/** Initial resize delivery from jsdom's modeled offsets; geometry/timing suites supply their own observers. */
import { afterAll, beforeEach } from 'vitest'

// The SVG animation player initializes a transparent 1px Canvas placeholder at import time.
const canvasPrototype = typeof HTMLCanvasElement === 'undefined' ? undefined : HTMLCanvasElement.prototype
const originalCanvasContext = canvasPrototype === undefined ? undefined : Object.getOwnPropertyDescriptor(canvasPrototype, 'getContext')
if (canvasPrototype !== undefined) {
  Object.defineProperty(canvasPrototype, 'getContext', {
    configurable: true,
    value: (contextId: string) => {
      if (contextId !== '2d') throw new Error(`test DOM: unsupported Canvas context ${contextId}`)
      return { fillStyle: '', fillRect: () => {} }
    },
  })
}

const original = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver')
let installed = false
const originalMatchMedia = typeof window === 'undefined' ? undefined : Object.getOwnPropertyDescriptor(window, 'matchMedia')
let installedMatchMedia = false

class TestResizeObserver implements ResizeObserver {
  private readonly targets = new Set<Element>()

  constructor(private readonly callback: ResizeObserverCallback) {}

  observe(target: Element): void {
    if (this.targets.has(target)) return
    this.targets.add(target)
    const width = target instanceof HTMLElement ? target.offsetWidth : 0
    const height = target instanceof HTMLElement ? target.offsetHeight : 0
    const size = [{ inlineSize: width, blockSize: height }]
    this.callback([{
      target, contentRect: new DOMRectReadOnly(0, 0, width, height),
      borderBoxSize: size, contentBoxSize: size, devicePixelContentBoxSize: size,
    }], this)
  }

  unobserve(target: Element): void { this.targets.delete(target) }

  disconnect(): void { this.targets.clear() }
}

beforeEach(() => {
  if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
    const matchMedia: Window['matchMedia'] = media => Object.assign(new EventTarget(), {
      media, matches: false, onchange: null, addListener: () => {}, removeListener: () => {},
    })
    Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: matchMedia })
    installedMatchMedia = true
  }
  if (typeof document !== 'undefined' && typeof ResizeObserver === 'undefined') {
    // Establish the per-environment default, so vi.unstubAllGlobals restores it.
    Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, writable: true, value: TestResizeObserver })
    installed = true
  }
})

afterAll(() => {
  if (canvasPrototype !== undefined) {
    if (originalCanvasContext === undefined) Reflect.deleteProperty(canvasPrototype, 'getContext')
    else Object.defineProperty(canvasPrototype, 'getContext', originalCanvasContext)
  }
  if (installed) {
    if (original === undefined) Reflect.deleteProperty(globalThis, 'ResizeObserver')
    else Object.defineProperty(globalThis, 'ResizeObserver', original)
  }
  if (installedMatchMedia) {
    if (originalMatchMedia === undefined) Reflect.deleteProperty(window, 'matchMedia')
    else Object.defineProperty(window, 'matchMedia', originalMatchMedia)
  }
})
