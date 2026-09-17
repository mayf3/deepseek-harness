/** Resolved document colors used by isolated diagram renderers. */

interface PreviewTheme {
  dark: boolean
  background: string
  surface: string
  text: string
  line: string
  border: string
}

/**
 * Read the palette after the application's theme presenter updates the DOM.
 * @returns Semantic preview colors and the resolved browser color scheme.
 */
export function readPreviewTheme(): PreviewTheme {
  const style = getComputedStyle(document.body)
  const color = (name: string): string => style.getPropertyValue(`--dsw-alias-${name}`).trim()
  return {
    dark: getComputedStyle(document.documentElement).colorScheme === 'dark',
    background: color('markdown-code-block'),
    surface: color('bg-layer-2'),
    text: color('label-primary'),
    line: color('label-secondary'),
    border: color('label-tertiary'),
  }
}
