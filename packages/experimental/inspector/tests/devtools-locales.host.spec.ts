/** Locale pruning changes the upstream menu source and dependency graph together. */
import { expect, it } from 'vitest'
import { configureDevtoolsLocales } from '../scripts/build-devtools.ts'
import { findDevtoolsDependencies } from '../scripts/download-devtools.ts'

it('keeps Chinese and English in both the I18n instance and its resource dependencies', () => {
  const source = 'const locales=["fr","en-US","zh","de"]; const bundled=["en-US","zh"]; new Lib.I18n.I18n(locales,"en-US");'
  const result = configureDevtoolsLocales(source)
  expect(result).toBe('const locales=["en-US","zh"]; const bundled=["en-US","zh"]; new Lib.I18n.I18n(locales,"en-US");')
  const root = new URL('https://cdn.example/serve_rev/@revision/')
  expect(findDevtoolsDependencies(result, new URL('core/i18n/i18n.js', root), root).urls.map(url => url.href)).toEqual([
    new URL('core/i18n/locales/en-US.json', root).href,
    new URL('core/i18n/locales/zh.json', root).href,
  ])
})

it('rejects an upstream locale declaration that no longer matches the distribution', () => {
  expect(() => configureDevtoolsLocales('const locales=["en-US"]; new Lib.I18n.I18n(locales,"en-US");'))
    .toThrow('every distributed locale')
  expect(() => configureDevtoolsLocales('new Lib.I18n.I18n(loadLocales(),"en-US");'))
    .toThrow('one supported-locale array')
})
