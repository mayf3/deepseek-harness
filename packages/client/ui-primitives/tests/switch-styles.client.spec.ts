/** Switch palette-independent thumb color as CSS text. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/Switch.module.css', import.meta.url)), 'utf8')

describe('Switch.module.css', () => {
  it('uses a white resting thumb and the active-track foreground while checked', () => {
    const restingThumb = /(?:^|\})\s*\.thumb\s*\{([^}]*)\}/.exec(css)?.[1]
    const checkedThumb = /\.switch\[aria-checked='true'\] \.thumb\s*\{([^}]*)\}/.exec(css)?.[1]
    expect(restingThumb).toContain('background: var(--dsw-static-neutral-00)')
    expect(checkedThumb).toContain('background: var(--dsw-alias-label-primary-foreground)')
  })
})
