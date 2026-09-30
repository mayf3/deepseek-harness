/** Dependency discovery for the immutable CDN mirror. */
import { expect, it } from 'vitest'
import { findDevtoolsDependencies } from '../scripts/download-devtools.ts'

const root = new URL('https://cdn.example/serve_rev/@revision/')
const file = new URL('panels/example/module.js', root)
const paths = (source: string, url = file) => findDevtoolsDependencies(source, url, root)
  .urls.map(dependency => dependency.pathname.slice(root.pathname.length)).sort()

it('follows static, exported, and literal dynamic imports together with Worker entrypoints and images', () => {
  expect(paths(`
    import './sibling.js';
    export * from '../../core/common/common.js';
    import('./lazy.js');
    import('node:worker_threads');
    const worker = import.meta.resolve('../../entrypoints/heap_snapshot_worker/heap_snapshot_worker-entrypoint.js');
    new URL('../../Images/icon.svg', import.meta.url);
    const image = 'Images/chromeLeft.avif';
    import('./lazy.js');
  `)).toEqual([
    'Images/chromeLeft.avif', 'Images/icon.svg', 'core/common/common.js',
    'entrypoints/heap_snapshot_worker/heap_snapshot_worker-entrypoint.js',
    'panels/example/lazy.js', 'panels/example/sibling.js',
  ])
})

it('follows HTML stylesheets and CSS assets without treating data URLs as downloads', () => {
  expect(paths('<script type="module" src="./main.js"></script><link href="./tokens.css" rel="stylesheet">',
    new URL('devtools_app.html', root))).toEqual(['main.js', 'tokens.css'])
  expect(paths('@import "./more.css"; body { background:url(../Images/icon.svg); src:url(data:font/woff2;base64,AAAA) }',
    new URL('styles/main.css', root))).toEqual(['Images/icon.svg', 'styles/more.css'])
})

it('discovers assets in emitted CSS modules but skips their diagnostic source URL', () => {
  expect(paths('const cssContent = "body { background:url(../../Images/icon.svg) }"; import.meta.resolve("./widget.css");',
    new URL('ui/example/widget.css.js', root))).toEqual(['Images/icon.svg'])
})

it('rejects module dependencies outside the pinned revision', () => {
  expect(() => paths('import "../../../other-revision/module.js"')).toThrow('escapes the pinned revision')
  expect(() => paths('import "https://other.example/module.js"')).toThrow('escapes the pinned revision')
})

it('enumerates every locale supplied to the upstream I18n constructor before any pruning', () => {
  expect(paths('const available = ["en-US", "zh", "fr"]; const i18n = new Library.I18n.I18n(available, "en-US");',
    new URL('core/i18n/i18n.js', root))).toEqual([
    'core/i18n/locales/en-US.json', 'core/i18n/locales/fr.json', 'core/i18n/locales/zh.json',
  ])
})

it('records bare and variable imports instead of inventing relative CDN paths for them', () => {
  const result = findDevtoolsDependencies('import("puppeteer"); import("node:fs"); import(workerEntry);', file, root)
  expect(result.urls).toEqual([])
  expect(result.externalModules).toEqual(['puppeteer', 'node:fs'])
  expect(result.dynamicImports).toEqual(['import(workerEntry)'])
})

it('follows the Lighthouse locale table with its upstream source-catalog exclusion', () => {
  expect(paths('const locales = ["en-US.json", "en-US.ctc.json", "fr.json"].filter(name => !name.endsWith(".ctc.json"));',
    new URL('third_party/lighthouse/lighthouse-dt-bundle.js', root))).toEqual([
    'third_party/lighthouse/locales/en-US.json', 'third_party/lighthouse/locales/fr.json',
  ])
})
