/**
 * Window drag recollection for the macOS desktop shell. Electron rebuilds the
 * window's `-webkit-app-region` rects only when a style pass changes a computed
 * app-region value (electron#32341), and Blink skips hidden boxes when it collects
 * them, so a chrome row that appears, moves, or disappears without such a change
 * leaves the native window holding the previous geometry: a press inside the row
 * drags from where it used to be, and a row that slid under the pointer keeps its
 * controls unreachable or its blank runs undraggable. This module owns the one
 * watcher that closes that gap, so no chrome row has to know the trap.
 *
 * A row's viewport box is the measurement: every row in this composition shows and
 * hides by mounting, unmounting, or moving, so a changed box is the signal. The
 * watcher starts on a DOM change that touches a marked row — inside it, on it, on
 * an ancestor that holds one, or adding or removing one — or on a marked row's box
 * resizing, and then measures every marked row once per frame for as long as any
 * box keeps changing. Each frame that changed sets the recall mark, and the frame
 * that finds the same geometry twice clears it and stops: that clear is the
 * collection the steady state comes from.
 * @module @deepseek-ai/dsh-client-web/src/window-drag/recall
 */
import { DRAG_MARK, RECALL_MARK } from './regions.ts'

/** The selector of an element that owns a window drag region. */
const ROW_SELECTOR = `[${DRAG_MARK}]`

/** How the shell installs the one window drag watcher. */
export interface WindowDragRecallOptions {
  /** Document whose marked rows are watched. */
  readonly document: Document
  /**
   * Schedules one frame callback and returns its canceller. The callback runs
   * asynchronously, as `requestAnimationFrame` does.
   */
  readonly scheduleFrame?: (frame: () => void) => () => void
  /**
   * Watches one row's border box and calls `changed` whenever it resizes, returning
   * a disposer. Defaults to a `ResizeObserver`; a document without one watches no
   * boxes and relies on the DOM changes alone.
   */
  readonly watchBox?: (row: Element, changed: () => void) => () => void
}

/**
 * Watch the window's marked drag rows and pulse the recall mark whenever their
 * geometry can have moved. Installs nothing outside the darwin platform, where no
 * app-region rule exists.
 * @param options - the document to watch and the two scheduling seams.
 * @returns a disposer that stops watching, drops any pending frame, and clears the mark.
 */
export function installWindowDragRecall(options: WindowDragRecallOptions): () => void {
  const doc = options.document
  if (doc.documentElement.dataset.platform !== 'darwin') return () => {}
  const scheduleFrame = options.scheduleFrame ?? defaultScheduleFrame
  const watchBox = options.watchBox ?? defaultWatchBox
  /** The last frame's measurement per row, the baseline a change is read against. */
  let geometry = new Map<Element, string>()
  /** One box watcher per row currently rendered. */
  const boxes = new Map<Element, () => void>()
  let scheduled = false
  let disposed = false
  let cancelPending: (() => void) | undefined

  /**
   * Measure every marked row and pulse when any box differs from the last frame's.
   * Runs once per frame while the surface keeps moving.
   */
  const measure = (): void => {
    // Clearing first is part of the pulse: a frame that finds a change re-marks,
    // and the frame that finds none leaves the surface collected as it settles.
    doc.body.removeAttribute(RECALL_MARK)
    const rows = Array.from(doc.querySelectorAll(ROW_SELECTOR))
    watchBoxes(rows)
    const next = new Map(rows.map(row => [row, readBox(row)] as const))
    const moved = rows.length !== geometry.size
      || rows.some(row => geometry.get(row) !== next.get(row))
    geometry = next
    if (!moved) return
    doc.body.setAttribute(RECALL_MARK, '')
    schedule()
  }

  /** Schedule one frame, keeping at most one pending. */
  const schedule = (): void => {
    if (scheduled) return
    scheduled = true
    cancelPending = scheduleFrame(() => {
      scheduled = false
      cancelPending = undefined
      // A seam that cannot cancel has already handed the frame over; a disposed
      // watcher must not measure, mark, or re-arm from it.
      if (disposed) return
      measure()
    })
  }

  /** Keep one box watcher per live row, re-watching when its frame moves or unmounts. */
  const watchBoxes = (rows: readonly Element[]): void => {
    for (const [row, dispose] of boxes) {
      if (rows.includes(row)) continue
      dispose()
      boxes.delete(row)
    }
    for (const row of rows) {
      if (boxes.has(row)) continue
      boxes.set(row, watchBox(row, schedule))
    }
  }

  const observer = new MutationObserver((records) => {
    if (records.some(touchesRows)) schedule()
  })
  observer.observe(doc.body, { subtree: true, childList: true, attributes: true, characterData: true })
  // The first frame collects the surface as it stands today.
  schedule()

  return () => {
    disposed = true
    observer.disconnect()
    if (cancelPending !== undefined) cancelPending()
    for (const dispose of boxes.values()) dispose()
    boxes.clear()
    geometry.clear()
    doc.body.removeAttribute(RECALL_MARK)
  }
}

/** The box a row owns this frame, in viewport pixels. */
function readBox(row: Element): string {
  const rect = row.getBoundingClientRect()
  return `${rect.x},${rect.y},${rect.width},${rect.height}`
}

/**
 * Whether one DOM change can have moved the drag surface: a child list change
 * that adds or removes a marked row, or an attribute or text change that lands on
 * a marked row, inside one, or on an element holding one (a panel's open flag, a
 * column's width). A child list change elsewhere is left alone — a row whose box
 * grows because its content did is a resize, which the box watcher reports — and
 * so is a mounted overlay, whose own app-region value is a change of its own.
 * @param record - the mutation record to classify.
 * @returns true when the drag surface has to be re-measured.
 */
function touchesRows(record: MutationRecord): boolean {
  // The pulse writes its own mark on the body; that write is not a movement, and
  // treating it as one would re-arm the watcher from its own output every frame.
  if (record.attributeName === RECALL_MARK) return false
  for (const node of [...record.addedNodes, ...record.removedNodes]) {
    if (node instanceof Element && (node.matches(ROW_SELECTOR) || node.querySelector(ROW_SELECTOR) !== null)) {
      return true
    }
  }
  if (record.type === 'childList') return false
  const target = record.target instanceof Element ? record.target : record.target.parentElement
  /* v8 ignore next -- the observer watches body's subtree, so a text target always has a parent element. */
  if (target === null) return false
  return target.closest(ROW_SELECTOR) !== null || target.querySelector(ROW_SELECTOR) !== null
}

/** Schedule one frame through the browser's animation frame queue. */
function defaultScheduleFrame(frame: () => void): () => void {
  const handle = requestAnimationFrame(frame)
  return () => { cancelAnimationFrame(handle) }
}

/** Watch one row's border box where the document has a `ResizeObserver`. */
function defaultWatchBox(row: Element, changed: () => void): () => void {
  if (typeof ResizeObserver !== 'function') return () => {}
  const observer = new ResizeObserver(changed)
  observer.observe(row)
  return () => { observer.disconnect() }
}
