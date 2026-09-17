/** Viewport-fitted image dialog with local pan and zoom transforms. */
import { useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import { IconCloseOutline16 } from '../icons/index.tsx'
import css from './PreviewLightbox.module.css'

/**
 * Fit a rendered diagram inside the viewport, with pointer pan and cursor-anchored zoom.
 * @param props - Image source, accessible labels, gesture instructions, and close callback.
 * @returns A dialog with drag, wheel and keyboard controls; double-click or Home restores the fitted view.
 */
export function PreviewLightbox({ src, alt, closeLabel, interactionLabel, onClose }: {
  src: string
  alt: string
  closeLabel: string
  interactionLabel: string
  onClose: () => void
}) {
  const closeRef = useRef<HTMLButtonElement | null>(null)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const surfaceRef = useRef<HTMLDivElement | null>(null)
  const hintId = useId()

  useEffect(() => {
    const restore = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeRef.current?.focus()
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
      // The close control is the dialog's only focusable element.
      if (event.key === 'Tab') event.preventDefault()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      restore?.focus()
    }
  }, [onClose])

  useEffect(() => {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- refs belong to this mounted dialog.
    const image = imageRef.current!
    // oxlint-disable-next-line typescript/no-non-null-assertion -- refs belong to this mounted dialog.
    const surface = surfaceRef.current!
    const view = { x: 0, y: 0, scale: 1 }
    let drag: { id: number; x: number; y: number } | undefined
    const paint = () => {
      image.style.transform = `translate(-50%, -50%) translate(${view.x}px, ${view.y}px) scale(${view.scale})`
    }
    const fit = () => {
      if (image.naturalWidth === 0 || image.naturalHeight === 0) return
      const scale = Math.min(window.innerWidth * 0.88 / image.naturalWidth, window.innerHeight * 0.84 / image.naturalHeight)
      image.style.width = `${image.naturalWidth * scale}px`
      image.style.height = `${image.naturalHeight * scale}px`
      view.x = 0
      view.y = 0
      view.scale = 1
      paint()
    }
    const zoom = (factor: number, x = 0, y = 0) => {
      const scale = Math.min(8, Math.max(0.25, view.scale * factor))
      const ratio = scale / view.scale
      view.x = x - (x - view.x) * ratio
      view.y = y - (y - view.y) * ratio
      view.scale = scale
      paint()
    }
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1
      const rect = surface.getBoundingClientRect()
      zoom(Math.exp(-event.deltaY * unit * 0.002), event.clientX - rect.left - rect.width / 2, event.clientY - rect.top - rect.height / 2)
    }
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || !event.isPrimary) return
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY }
      image.setPointerCapture(event.pointerId)
      image.dataset['dragging'] = ''
      event.preventDefault()
    }
    const onPointerMove = (event: PointerEvent) => {
      if (drag === undefined || drag.id !== event.pointerId) return
      view.x += event.clientX - drag.x
      view.y += event.clientY - drag.y
      drag.x = event.clientX
      drag.y = event.clientY
      paint()
    }
    const endDrag = () => {
      if (drag === undefined) return
      const id = drag.id
      drag = undefined
      delete image.dataset['dragging']
      if (image.hasPointerCapture(id)) image.releasePointerCapture(id)
    }
    const onPointerEnd = (event: PointerEvent) => {
      if (drag?.id === event.pointerId) endDrag()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === '+' || event.key === '=') zoom(1.2)
      else if (event.key === '-') zoom(1 / 1.2)
      else if (event.key === 'Home' || event.key === '0') fit()
      else {
        const dx = event.key === 'ArrowRight' ? 32 : event.key === 'ArrowLeft' ? -32 : 0
        const dy = event.key === 'ArrowDown' ? 32 : event.key === 'ArrowUp' ? -32 : 0
        if (dx === 0 && dy === 0) return
        view.x += dx
        view.y += dy
        paint()
      }
      event.preventDefault()
    }
    image.addEventListener('load', fit)
    image.addEventListener('dblclick', fit)
    image.addEventListener('pointerdown', onPointerDown)
    image.addEventListener('pointermove', onPointerMove)
    image.addEventListener('pointerup', onPointerEnd)
    image.addEventListener('pointercancel', onPointerEnd)
    image.addEventListener('lostpointercapture', onPointerEnd)
    surface.addEventListener('wheel', onWheel, { passive: false })
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', fit)
    fit()
    return () => {
      endDrag()
      image.removeEventListener('load', fit)
      image.removeEventListener('dblclick', fit)
      image.removeEventListener('pointerdown', onPointerDown)
      image.removeEventListener('pointermove', onPointerMove)
      image.removeEventListener('pointerup', onPointerEnd)
      image.removeEventListener('pointercancel', onPointerEnd)
      image.removeEventListener('lostpointercapture', onPointerEnd)
      surface.removeEventListener('wheel', onWheel)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', fit)
    }
  }, [src])

  return createPortal(
    <div ref={surfaceRef} className={css.backdrop} role="dialog" aria-modal="true" aria-label={alt} aria-describedby={hintId}>
      <div className={css.mask} aria-hidden="true" onMouseDown={onClose} />
      <img ref={imageRef} className={css.image} src={src} alt={alt} draggable={false} />
      <div id={hintId} className={css.hint}>{interactionLabel}</div>
      <button ref={closeRef} type="button" className={css.close} aria-label={closeLabel} onClick={onClose}>
        <span aria-hidden="true"><IconCloseOutline16 size={16} /></span>
      </button>
    </div>,
    document.body,
  )
}
