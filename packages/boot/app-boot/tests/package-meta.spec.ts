/** Plugin locale resources resolve independently of entry execution and package display fields. */

import fs, { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ModuleLoader } from '@deepseek-ai/cordis-plugin-loader'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readPluginMeta, resolvePluginResource } from '../src/package-meta.ts'

let root: string
let dir: string
let parentURL: string

function file(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

function manifest(exports: object, extra: object = {}): void {
  file(join(dir, 'package.json'), JSON.stringify({ name: 'localized', type: 'module', exports, ...extra }))
}

function dictionary(language: string, contents: unknown, directory = join(dir, 'locale')): void {
  file(join(directory, `${language}.json`), JSON.stringify(contents))
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-plugin-meta-'))
  dir = join(root, 'node_modules', 'localized')
  parentURL = pathToFileURL(join(root, 'entry.mjs')).href
  manifest({ '.': './index.js', './locale/*.json': './locale/*.json' }, { description: 'Not local display text.' })
  file(join(dir, 'index.js'), 'throw new Error("metadata must not execute the plugin")\n')
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

describe('plugin locale display metadata', () => {
  it.each([
    'C:\\plugins\\search.js',
    'C:/plugins/search.js',
    '\\\\server\\share\\plugins\\search.js',
    '//server/share/plugins/search.js',
    '.\\plugins\\search.js',
    './plugins/search.js',
    '../plugins/search.js',
    '/plugins/search.js',
    'file:///plugins/search.js',
    'file:///C:/plugins/search.js',
    'file://server/share/plugins/search.js',
  ])('does not resolve metadata resources for plugin file address %s', (specifier) => {
    const original = ModuleLoader.fromInternal
    const resolver = vi.spyOn(ModuleLoader, 'fromInternal')
    try {
      expect(readPluginMeta(specifier, parentURL)).toBeUndefined()
      expect(resolver).not.toHaveBeenCalled()
    } finally {
      resolver.mockRestore()
    }
    expect(ModuleLoader.fromInternal).toBe(original)
  })

  it('omits absent resources and absent meta fields without reading npm descriptions', () => {
    expect(readPluginMeta('localized', parentURL)).toBeUndefined()
    expect(readPluginMeta('absent', parentURL)).toBeUndefined()
    expect(readPluginMeta('node:fs', parentURL)).toBeUndefined()
    expect(readPluginMeta('fs', parentURL)).toBeUndefined()
    expect(readPluginMeta('cordis:group', parentURL)).toBeUndefined()
    dictionary('en', { other: { title: 'Not metadata' } })
    expect(readPluginMeta('localized', parentURL)).toBeUndefined()
    dictionary('en', { meta: {} })
    expect(readPluginMeta('localized', parentURL)).toBeUndefined()
  })

  it('reads direct fields, retains per-field translations, and ignores other locale content', () => {
    dictionary('en', { meta: { title: 'Team', description: 'Work together', ignored: false }, other: { nested: [1] } })
    dictionary('zh', { meta: { title: '团队' } })
    dictionary('pt-BR', { meta: { description: 'Trabalhar juntos' } })
    file(join(dir, 'locale', 'ignored.txt'), 'not JSON')
    expect(readPluginMeta('localized', parentURL)).toEqual({
      title: { en: 'Team', zh: '团队' },
      description: { en: 'Work together', 'pt-br': 'Trabalhar juntos' },
    })
  })

  it('treats percent markers as literal display text', () => {
    dictionary('en', { meta: { title: '%title%', description: 'Plugin %name%' } })
    expect(readPluginMeta('localized', parentURL)).toEqual({
      title: { en: '%title%' }, description: { en: 'Plugin %name%' },
    })
  })

  it('accepts description-only metadata and supplies the module name when a translated title has no English value', () => {
    dictionary('en', { meta: { description: 'About it' } })
    expect(readPluginMeta('localized', parentURL)).toEqual({ description: { en: 'About it' } })
    dictionary('zh', { meta: { title: '标题' } })
    expect(readPluginMeta('localized', parentURL)).toEqual({
      title: { en: 'localized', zh: '标题' }, description: { en: 'About it' },
    })
  })

  it('falls back to package fields when locale resources are absent', () => {
    manifest({ '.': './index.js', './package.json': './package.json' }, { description: 'Package introduction' })
    expect(readPluginMeta('localized', parentURL)).toEqual({ title: 'localized', description: 'Package introduction' })
  })

  it('falls back per field without replacing available locale translations', () => {
    manifest({ './locale/*.json': './locale/*.json', './package.json': './package.json' }, { description: 'Package introduction' })
    dictionary('en', { meta: { title: 'English title' } })
    dictionary('zh', { meta: { description: '中文介绍' } })
    expect(readPluginMeta('localized', parentURL)).toEqual({
      title: { en: 'English title' }, description: { en: 'Package introduction', zh: '中文介绍' },
    })
    dictionary('en', { meta: { description: 'English introduction' } })
    dictionary('zh', { meta: { title: '中文标题' } })
    expect(readPluginMeta('localized', parentURL)).toEqual({
      title: { en: 'localized', zh: '中文标题' }, description: { en: 'English introduction' },
    })
    dictionary('en', {})
    dictionary('zh', {})
    expect(readPluginMeta('localized', parentURL)).toEqual({ title: 'localized', description: 'Package introduction' })
  })

  it('retains non-English descriptions with an empty final English fallback', () => {
    dictionary('en', { meta: { title: 'Plugin' } })
    dictionary('zh', { meta: { description: '中文介绍' } })
    expect(readPluginMeta('localized', parentURL)).toEqual({
      title: { en: 'Plugin' }, description: { en: '', zh: '中文介绍' },
    })
  })

  it('uses only the package resource exported for the requested plugin address', () => {
    manifest({
      './package.json': './package.json',
      './search/package.json': './search-manifest.json',
    }, { description: 'Whole package' })
    file(join(dir, 'search-manifest.json'), JSON.stringify({ name: 'Search plugin', description: 'Search introduction' }))
    expect(readPluginMeta('localized/search', parentURL)).toEqual({ title: 'Search plugin', description: 'Search introduction' })
    expect(readPluginMeta('localized/review', parentURL)).toBeUndefined()
  })

  it.each([{}, { name: '', description: ' ' }, { name: false, description: null }])('ignores unavailable package text: %j', (fields) => {
    manifest({ './feature/package.json': './feature.json' })
    file(join(dir, 'feature.json'), JSON.stringify(fields))
    expect(readPluginMeta('localized/feature', parentURL)).toBeUndefined()
  })

  it('reports malformed fallback files', () => {
    manifest({ './feature/package.json': './feature.json' })
    file(join(dir, 'feature.json'), '{')
    expect(readPluginMeta('localized/feature', parentURL)?.error).toContain('feature.json')
  })

  it('does not hide invalid locale fields behind package text', () => {
    manifest({ './locale/*.json': './locale/*.json', './package.json': './package.json' }, { description: 'Package description' })
    dictionary('en', { meta: { title: false } })
    expect(readPluginMeta('localized', parentURL)?.error).toContain('meta.title must be a non-empty string')
  })

  it('does not inspect package fallback when both English fields are supplied', () => {
    manifest({ './locale/*.json': './locale/*.json', './package.json': './fallback.json' })
    file(join(dir, 'fallback.json'), '{')
    dictionary('en', { meta: { title: 'Plugin', description: 'Locale introduction' } })
    expect(readPluginMeta('localized', parentURL)).toEqual({
      title: { en: 'Plugin' }, description: { en: 'Locale introduction' },
    })
  })

  it('keeps separate plugin exports independent even when their JavaScript entries share a directory', () => {
    manifest({
      './search': './lib/search.js', './review': './lib/review.js',
      './search/locale/*.json': './resources/search/*.json',
      './review/locale/*.json': './resources/review/*.json',
      './locale/*.json': './locale/*.json',
    })
    file(join(dir, 'lib', 'search.js'), 'throw new Error("must not execute search")\n')
    file(join(dir, 'lib', 'review.js'), 'throw new Error("must not execute review")\n')
    dictionary('en', { meta: { title: 'Whole package' } })
    dictionary('en', { meta: { title: 'Search' } }, join(dir, 'resources', 'search'))
    dictionary('zh', { meta: { title: '搜索' } }, join(dir, 'resources', 'search'))
    dictionary('en', { meta: { title: 'Review' } }, join(dir, 'resources', 'review'))
    expect(readPluginMeta('localized/search', parentURL)).toEqual({ title: { en: 'Search', zh: '搜索' } })
    expect(readPluginMeta('localized/review', parentURL)).toEqual({ title: { en: 'Review' } })
    expect(readPluginMeta('localized/private', parentURL)).toBeUndefined()
  })

  it('reads scoped package roots and subexports at their complete addresses', () => {
    const scoped = join(root, 'node_modules', '@scope', 'localized')
    file(join(scoped, 'package.json'), JSON.stringify({
      name: '@scope/localized',
      exports: { './locale/*.json': './locale/*.json', './search/locale/*.json': './search-locale/*.json' },
    }))
    dictionary('en', { meta: { title: 'Scoped package' } }, join(scoped, 'locale'))
    dictionary('en', { meta: { title: 'Scoped search' } }, join(scoped, 'search-locale'))
    expect(readPluginMeta('@scope/localized', parentURL)).toEqual({ title: { en: 'Scoped package' } })
    expect(readPluginMeta('@scope/localized/search', parentURL)).toEqual({ title: { en: 'Scoped search' } })
  })

  it('uses ESM import conditions for locale exports without loading JSON modules', () => {
    manifest({ './locale/*.json': { import: './esm/*.json', require: './cjs/*.json' } })
    dictionary('en', { meta: { title: 'ESM' } }, join(dir, 'esm'))
    dictionary('en', { meta: { title: 'CJS' } }, join(dir, 'cjs'))
    expect(readPluginMeta('localized', parentURL)).toEqual({ title: { en: 'ESM' } })
  })

  it('does not read unexported language files directly from the resolved English directory', () => {
    manifest({ './locale/en.json': './locale/en.json' })
    dictionary('en', { meta: { title: 'English' } })
    dictionary('zh', { meta: { title: '中文' } })
    expect(readPluginMeta('localized', parentURL)?.error).toContain('./locale/zh.json')
  })

  it('reports language resources mapped outside their English directory', () => {
    manifest({ './locale/*.json': './locale/*.json', './locale/zh.json': './separate/zh.json' })
    dictionary('en', { meta: { title: 'English' } })
    dictionary('zh', { meta: { title: 'Local Chinese' } })
    dictionary('zh', { meta: { title: 'Mapped Chinese' } }, join(dir, 'separate'))
    expect(readPluginMeta('localized', parentURL)?.error).toContain('must share the English locale directory')
  })

  it('resolves same-named packages independently under each importing parent', () => {
    dictionary('en', { meta: { title: 'First' } })
    const second = join(root, 'second', 'node_modules', 'localized')
    file(join(second, 'package.json'), JSON.stringify({ name: 'localized', exports: { './locale/*.json': './locale/*.json' } }))
    dictionary('en', { meta: { title: 'Second' } }, join(second, 'locale'))
    const secondParent = pathToFileURL(join(root, 'second', 'entry.mjs')).href
    expect(readPluginMeta('localized', parentURL)).toEqual({ title: { en: 'First' } })
    expect(readPluginMeta('localized', secondParent)).toEqual({ title: { en: 'Second' } })
  })

  it.each([null, [], false, 1, 'text'])('reports malformed meta: %j', (meta) => {
    dictionary('en', { meta })
    expect(readPluginMeta('localized', parentURL)?.error).toContain('meta must be an object')
  })

  it.each([null, false, 1, {}, '', '  '])('reports a malformed display field: %j', (title) => {
    dictionary('en', { meta: { title } })
    const localeFile = resolvePluginResource('localized/locale/en.json', parentURL)
    expect(readPluginMeta('localized', parentURL)?.error).toContain(localeFile + ': meta.title must be a non-empty string')
  })

  it.each([[], null, 'text'])('rejects a non-object locale document: %j', (contents) => {
    dictionary('en', contents)
    expect(readPluginMeta('localized', parentURL)?.error).toContain('en.json must be an object')
  })

  it('reports malformed JSON and invalid language filenames', () => {
    dictionary('en', { meta: { title: 'Title' } })
    file(join(dir, 'locale', 'zh.json'), '{')
    expect(readPluginMeta('localized', parentURL)?.error).toContain('zh.json')
    rmSync(join(dir, 'locale', 'zh.json'))
    dictionary('not_a_language', { meta: { title: 'Title' } })
    expect(readPluginMeta('localized', parentURL)?.error).toContain('not_a_language.json must use a language id')
  })

  it('reports invalid export targets instead of treating them as absent metadata', () => {
    manifest({ './locale/*.json': '../outside/*.json' })
    expect(readPluginMeta('localized', parentURL)?.error).toContain('Invalid "exports" target')
  })

  it('reports an unavailable Node resolver without changing plugin state', () => {
    vi.spyOn(ModuleLoader, 'fromInternal').mockReturnValue(undefined)
    expect(readPluginMeta('localized', parentURL)?.error).toContain('requires the Node module resolver')
  })

  it.each(['v1', 'v2'] as const)('uses the %s Node resolver argument order', (version) => {
    const loader = ModuleLoader.fromInternal()!
    dictionary('en', { meta: { title: 'Resolved resource', description: 'Resolved introduction' } })
    const resolveSync = vi.fn(() => ({ url: pathToFileURL(join(dir, 'locale', 'en.json')).href }))
    const adapted = new Proxy(loader, {
      get(target, property) {
        if (property === 'version') return version
        if (property === 'resolveSync') return resolveSync
        const value: unknown = Reflect.get(target, property)
        return value
      },
    })
    vi.spyOn(ModuleLoader, 'fromInternal').mockReturnValue(adapted)
    expect(readPluginMeta('localized', parentURL)).toEqual({
      title: { en: 'Resolved resource' }, description: { en: 'Resolved introduction' },
    })
    const specifier = 'localized/locale/en.json'
    expect(resolveSync.mock.calls).toEqual(version === 'v1'
      ? [[specifier, parentURL, {}], [specifier, parentURL, {}]]
      : [[parentURL, { specifier, attributes: {} }], [parentURL, { specifier, attributes: {} }]])
  })

  it('rejects case-equivalent language names in a directory listing', () => {
    dictionary('en', { meta: { title: 'Title' } })
    const localeDir = dirname(resolvePluginResource('localized/locale/en.json', parentURL))
    const original = fs.readdirSync
    const english = original(localeDir, { withFileTypes: true })[0]!
    const duplicate = original(localeDir, { withFileTypes: true })[0]!
    duplicate.name = 'EN.json'
    // Case-insensitive filesystems cannot store both names in the same directory.
    const listing = vi.spyOn(fs, 'readdirSync')
    try {
      listing.mockImplementation(new Proxy(original, {
        apply(target, receiver: unknown, args: unknown[]): unknown {
          if (args[0] === localeDir) return [english, duplicate]
          return Reflect.apply(target, receiver, args)
        },
      }))
      syncBuiltinESMExports()
      expect(fs.readdirSync(dir, { withFileTypes: true })).toEqual(original(dir, { withFileTypes: true }))
      expect(readPluginMeta('localized', parentURL)?.error).toContain('localized/locale/EN.json duplicates locale en')
    } finally {
      listing.mockRestore()
      syncBuiltinESMExports()
    }
    expect(fs.readdirSync).toBe(original)
    expect(readdirSync).toBe(original)
    expect(readPluginMeta('localized', parentURL)).toEqual({ title: { en: 'Title' } })
  })

  it('rejects case-equivalent language files on case-sensitive filesystems', (context) => {
    dictionary('en', { meta: { title: 'Title' } })
    dictionary('EN', { meta: { title: 'Other' } })
    // Case-insensitive filesystems cannot hold both filenames.
    if (readdirSync(join(dir, 'locale')).length !== 2) context.skip()
    expect(readPluginMeta('localized', parentURL)?.error).toContain('duplicates locale en')
  })
})
