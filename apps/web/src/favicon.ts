/** Browser-tab icons follow the system scheme independently of the application theme. */
import favicon from '../public/favicon.svg?raw'

/**
 * Install fixed-color icons and a document-lifetime system-scheme listener.
 * Browser favicon rasterizers can cache SVG media-query results across scheme changes.
 * Distinct data URLs select explicit colors without duplicating the source artwork.
 */
export function installFavicon(): void {
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
  if (link === null) throw new Error('web app: missing favicon link')
  const svg = new DOMParser().parseFromString(favicon, 'image/svg+xml')
  svg.querySelector('style')?.remove()
  const path = svg.querySelector('path')
  if (path === null) throw new Error('web app: missing favicon path')
  const icon = (fill: string): string => {
    path.setAttribute('fill', fill)
    return `data:image/svg+xml,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`
  }
  const light = icon('#000')
  const dark = icon('#fff')
  const scheme = window.matchMedia('(prefers-color-scheme: dark)')
  const update = (): void => { link.href = scheme.matches ? dark : light }
  update()
  scheme.addEventListener('change', update)
}
