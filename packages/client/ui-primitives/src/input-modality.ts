/**
 * Input modality for the whole document, under the two rules its consumers need.
 *
 * A tooltip asks what the last input was: after any key the user is working from
 * the keyboard, so a programmatic focus may raise a bubble. A focus ring asks
 * something narrower — a pointer's focus must stay invisible — because Chromium
 * reveals an already-focused control as soon as any key arrives, including a
 * modifier or Escape that never navigated anywhere. Only focus navigation
 * returns that second answer to the keyboard.
 *
 * Both are recorded from capture-phase window listeners. The guard keeps the
 * module loadable where no window exists (node-side imports of the package's
 * pure helpers).
 */

/** Modality values published on the document element. */
export const INPUT_MODALITY = { pointer: 'pointer', keyboard: 'keyboard' } as const

/** Attribute carrying whether focus navigation last owned focus. */
export const INPUT_MODALITY_ATTRIBUTE = 'data-input-modality'

let pointer = false
let pointerOwnsFocus = false

/** Navigation keys move focus; every other key must not reveal existing focus. */
function isFocusNavigation(event: KeyboardEvent): boolean {
  return event.key === 'Tab' || event.key.startsWith('Arrow')
}

function publish(): void {
  document.documentElement.setAttribute(INPUT_MODALITY_ATTRIBUTE, pointerOwnsFocus ? INPUT_MODALITY.pointer : INPUT_MODALITY.keyboard)
}

/** Whether the last input able to own focus came from a pointer. */
export function pointerModality(): boolean {
  return pointer
}

if (typeof window !== 'undefined') {
  window.addEventListener('pointerdown', () => {
    pointer = true
    pointerOwnsFocus = true
    publish()
  }, true)
  window.addEventListener('keydown', (event) => {
    // Any key returns tooltips to the keyboard; only navigation reveals a ring.
    pointer = false
    if (!isFocusNavigation(event)) return
    pointerOwnsFocus = false
    publish()
  }, true)
}
