import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  projectCordisCatalog,
  renderInheritedPage,
  renderPageRegion,
  type CordisCatalogPolicy,
} from '../src/cordis-catalog.ts'
import { CORDIS_CATALOG_POLICY, EVENT_SCOPE_PAGE, REGION_BEGIN, REGION_END, SERVICE_PAGE } from '../../../../scripts/gen-cordis-catalog.ts'

const workspaceRoot = resolve(import.meta.dirname, '../../../..')

const SOURCE_LINK_POLICY: CordisCatalogPolicy = {
  linkedTypePages: {},
  foundationTypeNames: new Set(),
  typeLinkExemptions: {},
  inheritedEvents: [{ name: 'ready', summary: 'Ready.', source: 'vendor/cordis/src/events.ts:9' }],
  inheritedServices: [{ name: 'ctx.root', summary: 'Root.', source: 'vendor/cordis/src/context.ts:12' }],
}

describe('Typert-backed Cordis catalog', () => {
  it('omits subsystem source lines while preserving inherited Cordis source lines', () => {
    const page = renderPageRegion('fixture.md', [{
      key: 'fixture',
      type: 'Fixture',
      abstract: false,
      doc: 'Fixture.',
      methods: [],
      source: 'packages/fixture/service.ts:24',
    }], [{
      name: 'fixture/ready',
      scope: 'fixture',
      signature: "'fixture/ready'(): void",
      jsDoc: '/** Ready. */',
      mode: 'emit',
      doc: 'Ready.',
      source: 'packages/fixture/events.ts:42',
    }], SOURCE_LINK_POLICY)
    const inherited = renderInheritedPage(SOURCE_LINK_POLICY)

    expect(page).toContain('Source: [`packages/fixture/events.ts`](../../packages/fixture/events.ts)')
    expect(page).toContain('Source: [`packages/fixture/service.ts`](../../packages/fixture/service.ts)')
    expect(inherited).toContain('([`vendor/cordis/src/events.ts:9`](../../vendor/cordis/src/events.ts))')
    expect(inherited).toContain('([`vendor/cordis/src/context.ts:12`](../../vendor/cordis/src/context.ts))')
  })

  it('reproduces every committed catalog artifact byte for byte', { timeout: 480_000 }, () => {
    const { projector, model } = projectCordisCatalog(workspaceRoot, CORDIS_CATALOG_POLICY)
    const expected = (path: string): string => readFileSync(join(workspaceRoot, path), 'utf8')

    expect(renderInheritedPage(CORDIS_CATALOG_POLICY)).toBe(expected('docs/cordis-api/inherited.md'))
    for (const page of [...new Set([...Object.values(SERVICE_PAGE), ...Object.values(EVENT_SCOPE_PAGE)])].sort()) {
      const region = renderPageRegion(
        page,
        [...model.services].filter(s => SERVICE_PAGE[s.key] === page),
        [...model.events].filter(e => EVENT_SCOPE_PAGE[e.scope] === page),
        CORDIS_CATALOG_POLICY,
      )
      for (const side of [page, page.replace(/\.md$/, '.zh.md')]) {
        const committed = expected(`docs/subsystems/${side}`)
        const begin = committed.indexOf(REGION_BEGIN)
        const end = committed.indexOf(REGION_END)
        expect(begin, `docs/subsystems/${side} carries the region`).toBeGreaterThanOrEqual(0)
        expect(committed.slice(begin, end + REGION_END.length)).toBe(region)
      }
    }
    expect(projector.renderRuntimeApi(model)).toBe(
      expected('packages/self-modification/tool-cordis/src/api-catalog.ts'),
    )
  })
})
