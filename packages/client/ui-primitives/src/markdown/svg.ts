/** SVG image previews without executable source markup. */

/**
 * Prepare an SVG image URL without activating SVG scripts, links, or external resources.
 * @param code - Complete SVG XML; malformed XML or a non-SVG root throws.
 * @param signal - Prevents preparation after the preview owner is cancelled.
 * @returns A data URL for an image whose intrinsic dimensions determine the preview height.
 */
export function renderSvg(code: string, signal: AbortSignal): string {
  signal.throwIfAborted()
  const parsed = new DOMParser().parseFromString(code, 'image/svg+xml')
  if (parsed.querySelector('parsererror') !== null || parsed.documentElement.localName !== 'svg'
    || parsed.documentElement.namespaceURI !== 'http://www.w3.org/2000/svg') {
    throw new Error('Invalid SVG document')
  }
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(code)}`
}
