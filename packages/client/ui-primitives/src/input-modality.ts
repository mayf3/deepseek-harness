/**
 * Last-input modality for the whole document. Focus alone cannot reveal how it
 * arrived: a closing menu hands focus back to its trigger, and after a mouse
 * selection that programmatic return must stay silent, while keyboard focus
 * must not. Capture-phase window listeners record the modality, and only focus
 * navigation returns the document to the keyboard — a stray modifier or Escape
 * is not a reason to reveal the pointer's focus.
 *
 * The guard keeps the module loadable where no window exists (node-side imports
 * of the package's pure helpers).
 */

/** Modality values published on the document element. */
export const INPUT_MODALITY = { pointer: 'pointer', keyboard: 'keyboard' } as const

/** Attribute carrying the current modality, read by the global focus sheet. */
export const INPUT_MODALITY_ATTRIBUTE = 'data-input-modality'

let pointer = false

/** Navigation keys move focus; every other key must not reveal existing focus. */
function isFocusNavigation(event: KeyboardEvent): boolean {
  return event.key === 'Tab' || event.key.startsWith('Arrow')
}

function publish(): void {
  document.documentElement.setAttribute(INPUT_MODALITY_ATTRIBUTE, pointer ? INPUT_MODALITY.pointer : INPUT_MODALITY.keyboard)
}

/** Whether the last input able to own focus came from a pointer. */
export function pointerModality(): boolean {
  return pointer
}

if (typeof window !== 'undefined') {
  window.addEventListener('pointerdown', () => { pointer = true; publish() }, true)
  window.addEventListener('keydown', (event) => {
    if (!isFocusNavigation(event)) return
    pointer = false
    publish()
  }, true)
}
