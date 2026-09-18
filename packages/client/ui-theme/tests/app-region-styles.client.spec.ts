/**
 * Window drag-region ownership, asserted against the CSS text on disk:
 * `-webkit-app-region: drag` appears only in the two chrome bands that mount
 * before all content — ui-layout's frame band and ui-sidebar's logo row.
 * Electron composes app-regions from window geometry in DOM order, ignoring
 * stacking: a drag rule on a content container overrides the no-drag of any
 * overlay mounted earlier, so its controls drag the window instead of
 * receiving clicks. Everything interactive opts out through ui-web base.css.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { packageStylesheets, parseRules } from './stylesheet-scan.ts'

/** The only stylesheets allowed to declare a window drag region, relative to packages/. */
const DRAG_OWNERS = [
  'client/ui-layout/src/client/AppFrame.module.css',
  'client/ui-sidebar/src/client/SidebarRoot.module.css',
]

/**
 * Selectors of rules declaring a window drag region.
 * @param css - stylesheet text.
 * @returns the declaring selectors, in source order.
 */
function dragSelectors(css: string): string[] {
  return parseRules(css)
    .filter(rule => rule.declarations
      .some(([property, value]) => property === '-webkit-app-region' && value === 'drag'))
    .map(rule => rule.selectors.join(', '))
}

describe('window drag-region ownership', () => {
  it('rejects a drag declaration and passes no-drag', () => {
    expect(dragSelectors('.a { -webkit-app-region: drag; }')).toEqual(['.a'])
    expect(dragSelectors('.a { -webkit-app-region: no-drag; }')).toEqual([])
  })

  it('keeps -webkit-app-region: drag inside the two chrome bands', () => {
    const offenders = packageStylesheets()
      .filter(file => !DRAG_OWNERS.some(owner => file.endsWith(`/${owner}`)))
      .flatMap(file => dragSelectors(readFileSync(file, 'utf8')).map(selectors => `${file} ${selectors}`))
    expect(offenders).toEqual([])
  })

  it('still finds a drag band in every allowlisted owner', () => {
    // An owner that stops declaring drag should leave the allowlist with it.
    for (const owner of DRAG_OWNERS) {
      const file = packageStylesheets().find(candidate => candidate.endsWith(`/${owner}`))
      expect(file, owner).toBeDefined()
      expect(dragSelectors(readFileSync(file!, 'utf8')), owner).not.toEqual([])
    }
  })
})
