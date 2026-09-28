/** Bundle metadata checks use source-only packages and real resource exports. */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { packageMetaProblems } from './verify-package-meta.ts'

let root: string
let dir: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-meta-gate-'))
  dir = join(root, 'packages', 'test', 'plugin')
  mkdirSync(dir, { recursive: true })
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

function file(path: string, contents: string): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true })
  writeFileSync(join(dir, path), contents)
}

function json(path: string, contents: unknown): void {
  file(path, JSON.stringify(contents))
}

function manifest(fields: object = {}): void {
  json('package.json', {
    name: '@test/plugin',
    description: 'Package description',
    type: 'module',
    dsh: { bundle: { patch: './cordis.yml' } },
    exports: { '.': './lib/index.js', './package.json': './package.json', './locale/*.json': './locale/*.json' },
    files: ['lib', 'locale'],
    ...fields,
  })
}

it('rejects an empty workspace package corpus', () => {
  expect(packageMetaProblems(root).join('\n')).toContain('no workspace package manifests')
})

it.each([undefined, {}, { bundle: {} }, { profile: { bundles: [] } }])(
  'ignores ordinary package JSON display metadata: %j', (dsh) => {
    manifest({ dsh, icon: './missing.svg', exports: { '.': './entry.js' }, files: [] })
    file('entry.js', "throw new Error('plugin entry executed')")
    file('locale/en.json', '{')
    json('locale/zh.json', { meta: { title: false } })
    expect(packageMetaProblems(root)).toEqual([])
  },
)

it('ignores exported ordinary plugin metadata within a bundle', () => {
  manifest({
    exports: {
      './package.json': './package.json',
      './search': './entry.js',
      './search/package.json': './search/package.json',
      './search/locale/*.json': './search/locale/*.json',
    },
    files: [],
  })
  json('search/package.json', { icon: './missing.svg' })
  json('search/locale/en.json', { meta: { title: false } })
  json('locale/other/zh.json', { meta: { description: false } })
  expect(packageMetaProblems(root)).toEqual([])
})

it('does not require locales for bundle manifest name and description', () => {
  manifest({ exports: { './package.json': './package.json' }, files: [] })
  expect(packageMetaProblems(root)).toEqual([])
})

it.each([undefined, ['art'], ['art/*.svg'], ['./art/icon.svg']])('accepts a published bundle icon: %j', (files) => {
  manifest({ icon: './art/icon.svg', files })
  file('art/icon.svg', '<svg/>')
  expect(packageMetaProblems(root)).toEqual([])
})

it.each([['lib'], ['art', '!art/icon.svg']])('rejects an unpublished bundle icon: %j', (...files) => {
  manifest({ icon: './art/icon.svg', files })
  file('art/icon.svg', '<svg/>')
  expect(packageMetaProblems(root).join('\n')).toContain('files must include art/icon.svg')
})

it.each([null, false, 1, '', './icon.gif', '/tmp/icon.svg', './missing.png', '../outside.svg'])('validates bundle icons: %j', (icon) => {
  manifest({ icon })
  file('../outside.svg', '<svg/>')
  expect(packageMetaProblems(root).join('\n')).toContain('Plugin metadata for @test/plugin:')
})

it('requires the bundle icon declaration to be exported', () => {
  manifest({ icon: './icon.svg', exports: { '.': './entry.js' }, files: ['icon.svg'] })
  file('icon.svg', '<svg/>')
  expect(packageMetaProblems(root).join('\n')).toContain('exports must expose its icon declaration')
})

it('reads bundle resources without evaluating entries or built output', () => {
  manifest({ exports: { '.': './entry.js', './locale/*.json': './locale/*.json' } })
  file('entry.js', "import { writeFileSync } from 'node:fs'; writeFileSync(new URL('./executed', import.meta.url), 'yes'); throw new Error('entry executed')")
  json('locale/en.json', { meta: { title: 'Bundle', description: '%literal%' } })
  json('locale/zh.json', { meta: { title: '组合包' }, nested: [1, null] })
  expect(packageMetaProblems(root)).toEqual([])
  expect(existsSync(join(dir, 'executed'))).toBe(false)
  expect(existsSync(join(dir, 'lib'))).toBe(false)
})

it.each(['lib', 'tests'])('rejects bundle resources outside source discovery: %s', (directory) => {
  manifest({ icon: './missing.svg', exports: { './package.json': './package.json', './locale/en.json': `./${directory}/en.json` } })
  file(`${directory}/en.json`, '{')
  const problems = packageMetaProblems(root).join('\n')
  expect(problems).toContain('source JSON')
  expect(problems).not.toContain('Plugin metadata for')
})

it.each([
  './resources/*.json',
  { types: './missing/*.json', import: './resources/*.json', require: './missing/*.json' },
  { node: { import: './resources/*.json' }, default: './missing/*.json' },
  [null, './resources/*.json'],
])('accepts Node-selected bundle resource exports: %j', (target) => {
  manifest({ exports: { './locale/*.json': target }, files: ['resources'] })
  json('resources/en.json', { meta: { title: 'Bundle' } })
  json('resources/zh.json', { meta: { title: '组合包' } })
  expect(packageMetaProblems(root)).toEqual([])
})

it.each([
  { '.': './lib/index.js' },
  { './locale/*.json': null },
  { './locale/*.json': { require: './locale/*.json' } },
  { './locale/*.json': './locale/*.json', './locale/en.json': null },
  { './locale/*.json': ['./missing/*.json', './locale/*.json'] },
])('rejects inaccessible root bundle metadata: %j', (exports) => {
  manifest({ exports })
  json('locale/en.json', { meta: { title: 'Bundle' } })
  expect(packageMetaProblems(root).join('\n')).toContain('en.json')
})

it.each(['locale', 'resources'])('requires an English discovery resource for translated bundle metadata in %s', (directory) => {
  manifest({ exports: { './locale/*.json': `./${directory}/*.json` } })
  json(`${directory}/zh.json`, { meta: { title: '组合包' } })
  expect(packageMetaProblems(root).join('\n')).toContain('en.json')
})

it('rejects inaccessible bundle metadata outside the conventional locale directory', () => {
  manifest({ exports: { './locale/*.json': { require: './resources/*.json' } } })
  json('resources/en.json', { meta: { title: 'Bundle' } })
  expect(packageMetaProblems(root).join('\n')).toContain('en.json')
})

it('discovers bundle locales through a general export wildcard without claiming child locales', () => {
  manifest({ exports: { './*': './resources/*' }, files: ['resources/locale'] })
  json('resources/locale/en.json', { meta: { title: 'Bundle' } })
  json('resources/search/locale/en.json', { meta: { title: false } })
  expect(packageMetaProblems(root)).toEqual([])
})

it('requires exports and publication for each bundle translation', () => {
  manifest({ exports: { './locale/en.json': './locale/en.json' }, files: ['locale/en.json'] })
  json('locale/en.json', { meta: { title: 'Bundle' } })
  json('locale/zh.json', { meta: { title: '组合包' } })
  const problems = packageMetaProblems(root).join('\n')
  expect(problems).toContain('exports must expose @test/plugin/locale/zh.json')
  expect(problems).toContain('files must include locale/zh.json')
})

it('rejects bundle translations mapped outside the English directory', () => {
  manifest({ exports: { './locale/en.json': './locale/en.json', './locale/zh.json': './elsewhere/zh.json' } })
  json('locale/en.json', { meta: { title: 'Bundle' } })
  json('elsewhere/zh.json', { meta: { title: '组合包' } })
  expect(packageMetaProblems(root).join('\n')).toContain('must share the English locale directory')
})

it.each([null, [], false, 1, 'text'])('rejects malformed bundle locale metadata: %j', (meta) => {
  manifest()
  json('locale/en.json', { meta })
  expect(packageMetaProblems(root).join('\n')).toContain('meta')
})

it.each(['en', 'zh'])('rejects malformed bundle locale JSON: %s', (language) => {
  manifest()
  json('locale/en.json', { meta: { title: 'Bundle' } })
  file(`locale/${language}.json`, '{')
  expect(packageMetaProblems(root).join('\n')).toContain(`${language}.json`)
})

it('ignores unrelated JSON and locale content without display metadata', () => {
  manifest({ exports: { './package.json': './package.json' } })
  json('data.json', { meta: { title: false } })
  json('locale/zh.json', { buttons: { save: '保存' } })
  json('tests/locale/en.json', { meta: { title: false } })
  expect(packageMetaProblems(root)).toEqual([])
})

it('reports invalid metadata across multiple bundles', () => {
  manifest()
  json('locale/en.json', { meta: { title: false } })
  dir = join(root, 'packages', 'another', 'second')
  manifest({ name: '@test/second' })
  json('locale/en.json', { meta: { description: '' } })
  const problems = packageMetaProblems(root).join('\n')
  expect(problems).toContain('@test/plugin')
  expect(problems).toContain('@test/second')
})
