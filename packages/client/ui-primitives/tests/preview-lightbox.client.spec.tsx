// @vitest-environment jsdom

import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PreviewLightbox } from '../src/markdown/PreviewLightbox.tsx'

beforeEach(() => {
  vi.stubGlobal('innerWidth', 1000)
  vi.stubGlobal('innerHeight', 800)
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

const props = {
  src: 'data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E',
  alt: 'Diagram preview',
  closeLabel: 'Close preview',
  interactionLabel: 'Drag or arrow keys to pan; scroll or +/- to zoom; double-click or Home to fit',
}

function fixture(width = 400, height = 200) {
  const onClose = vi.fn()
  const view = render(<PreviewLightbox {...props} onClose={onClose} />)
  const image = view.getByRole('img') as HTMLImageElement
  const surface = view.getByRole('dialog')
  // jsdom has neither image decoding nor pointer capture; provide the browser-owned observations.
  Object.defineProperty(image, 'naturalWidth', { configurable: true, value: width })
  Object.defineProperty(image, 'naturalHeight', { configurable: true, value: height })
  vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 1000, 800))
  const capture = new Set<number>()
  const release = vi.fn((id: number) => { capture.delete(id) })
  Object.defineProperties(image, {
    setPointerCapture: { value: (id: number) => { capture.add(id) } },
    hasPointerCapture: { value: (id: number) => capture.has(id) },
    releasePointerCapture: { value: release },
  })
  fireEvent.load(image)
  function pointer(type: string, x: number, y: number, id = 1, button = 0, primary = true) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button })
    Object.defineProperties(event, { pointerId: { value: id }, isPrimary: { value: primary } })
    fireEvent(image, event)
  }
  return { ...view, image, surface, onClose, pointer, release, capture }
}

const fitted = 'translate(-50%, -50%) translate(0px, 0px) scale(1)'

describe('PreviewLightbox', () => {
  it('fits the image with viewport margins, closes and restores keyboard focus', () => {
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    try {
      opener.focus()
      const view = fixture()
      expect(Number.parseFloat(view.image.style.width)).toBeCloseTo(880)
      expect(Number.parseFloat(view.image.style.height)).toBeCloseTo(440)
      expect(view.image.style.transform).toBe(fitted)
      expect(view.surface.getAttribute('aria-describedby')).toBe(view.getByText(props.interactionLabel).id)
      const close = view.getByRole('button', { name: props.closeLabel })
      expect(document.activeElement).toBe(close)
      expect(fireEvent.keyDown(window, { key: 'Tab' })).toBe(false)
      expect(fireEvent.keyDown(window, { key: 'a' })).toBe(true)
      expect(view.onClose).not.toHaveBeenCalled()
      fireEvent.keyDown(window, { key: 'Escape' })
      fireEvent.click(close)
      expect(view.onClose).toHaveBeenCalledTimes(2)
      view.unmount()
      expect(document.activeElement).toBe(opener)
    } finally { opener.remove() }
  })

  it('fits tall images by height and waits for intrinsic dimensions before fitting', () => {
    const tall = fixture(200, 800)
    expect(Number.parseFloat(tall.image.style.width)).toBeCloseTo(168)
    expect(Number.parseFloat(tall.image.style.height)).toBeCloseTo(672)
    tall.unmount()
    const pending = fixture(400, 0)
    expect(pending.image.style.width).toBe('')
    Object.defineProperty(pending.image, 'naturalHeight', { value: 200 })
    fireEvent.load(pending.image)
    expect(Number.parseFloat(pending.image.style.width)).toBeCloseTo(880)
  })

  it('anchors wheel zoom at the cursor, normalizes wheel units and bounds magnification', () => {
    const view = fixture()
    expect(fireEvent.wheel(view.surface, { deltaY: -Math.log(2) / 0.002, clientX: 600, clientY: 450 })).toBe(false)
    expect(view.image.style.transform).toBe('translate(-50%, -50%) translate(-100px, -50px) scale(2)')
    fireEvent.wheel(view.surface, { deltaY: 1, deltaMode: 1, clientX: 600, clientY: 450 })
    expect(view.image.style.transform).toContain(`scale(${2 * Math.exp(-16 * 0.002)})`)
    fireEvent.wheel(view.surface, { deltaY: 10, deltaMode: 2 })
    expect(view.image.style.transform).toContain('scale(0.25)')
    fireEvent.wheel(view.surface, { deltaY: -10000 })
    expect(view.image.style.transform).toContain('scale(8)')
    expect(view.image.getAttribute('src')).toBe(props.src)
    fireEvent.doubleClick(view.image)
    expect(view.image.style.transform).toBe(fitted)
  })

  it('captures a primary drag and ignores other pointers and inactive movement', () => {
    const view = fixture()
    view.pointer('pointerdown', 500, 400, 1, 2)
    view.pointer('pointerdown', 500, 400, 2, 0, false)
    view.pointer('pointermove', 540, 420)
    expect(view.capture.size).toBe(0)
    expect(view.image.style.transform).toBe(fitted)
    view.pointer('pointerdown', 500, 400)
    expect(view.capture.has(1)).toBe(true)
    expect(view.image.hasAttribute('data-dragging')).toBe(true)
    view.pointer('pointermove', 540, 420, 2)
    view.pointer('pointerup', 540, 420, 2)
    expect(view.image.style.transform).toBe(fitted)
    view.pointer('pointermove', 580, 440)
    expect(view.image.style.transform).toBe('translate(-50%, -50%) translate(80px, 40px) scale(1)')
    view.pointer('pointerup', 580, 440)
    expect(view.release).toHaveBeenCalledWith(1)
    expect(view.image.hasAttribute('data-dragging')).toBe(false)
    view.pointer('pointermove', 900, 900)
    expect(view.image.style.transform).toContain('translate(80px, 40px)')
  })

  it.each(['pointercancel', 'lostpointercapture'])('ends a gesture on %s and releases capture on unmount', (type) => {
    const view = fixture()
    view.pointer('pointerdown', 500, 400)
    view.capture.clear()
    view.pointer(type, 500, 400)
    view.pointer('pointermove', 700, 500)
    expect(view.image.style.transform).toBe(fitted)
    view.pointer('pointerdown', 500, 400)
    view.unmount()
    expect(view.release).toHaveBeenCalledWith(1)
    view.pointer('pointermove', 700, 500)
    expect(view.image.style.transform).toBe(fitted)
  })

  it('supports keyboard pan, zoom and reset, and refits on viewport or source changes', () => {
    const view = fixture()
    for (const key of ['ArrowRight', 'ArrowDown']) fireEvent.keyDown(window, { key })
    expect(view.image.style.transform).toContain('translate(32px, 32px)')
    for (const key of ['ArrowLeft', 'ArrowUp', '+', '-']) fireEvent.keyDown(window, { key })
    expect(view.image.style.transform).toBe(fitted)
    fireEvent.keyDown(window, { key: '=' })
    expect(view.image.style.transform).toContain('scale(1.2)')
    fireEvent.keyDown(window, { key: '0' })
    expect(view.image.style.transform).toBe(fitted)
    fireEvent.keyDown(window, { key: '+' })
    fireEvent.keyDown(window, { key: 'Home' })
    expect(view.image.style.transform).toBe(fitted)
    fireEvent.keyDown(window, { key: '+' })
    vi.stubGlobal('innerWidth', 600)
    fireEvent.resize(window)
    expect(Number.parseFloat(view.image.style.width)).toBeCloseTo(528)
    expect(view.image.style.transform).toBe(fitted)
    fireEvent.keyDown(window, { key: '+' })
    view.rerender(<PreviewLightbox {...props} src={`${props.src}#new`} onClose={view.onClose} />)
    expect(view.image.style.transform).toBe(fitted)
    view.unmount()
    fireEvent.keyDown(window, { key: '+' })
    fireEvent.wheel(view.surface, { deltaY: -100 })
    expect(view.image.style.transform).toBe(fitted)
  })

  it('tolerates a focus owner it cannot restore', () => {
    Object.defineProperty(document, 'activeElement', { configurable: true, get: () => null })
    try {
      const view = render(<PreviewLightbox {...props} onClose={vi.fn()} />)
      view.unmount()
    } finally { delete (document as { activeElement?: unknown }).activeElement }
  })

  it('closes on a mask press but not on a press over the image', () => {
    const view = fixture()
    fireEvent.mouseDown(view.image)
    expect(view.onClose).not.toHaveBeenCalled()
    fireEvent.mouseDown(view.surface.querySelector('[aria-hidden="true"]')!)
    expect(view.onClose).toHaveBeenCalledOnce()
  })
})
