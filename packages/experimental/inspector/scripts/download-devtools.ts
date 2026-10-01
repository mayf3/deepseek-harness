/** Mirror a fixed Chromium DevTools resource graph without changing its directory layout. */
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

/** DevTools revision shipped by Chrome 150.0.7871.186. */
export const DEVTOOLS_REVISION = 'ec97cf3bbeea2cb623fbf97c4e3f22f5acb4d568'
/** Chrome release supplying the pinned frontend. */
export const DEVTOOLS_CHROMIUM_VERSION = '150.0.7871.186'
/** Immutable upstream root used by the local frontend distribution. */
export const DEVTOOLS_CDN = new URL(`https://chrome-devtools-frontend.appspot.com/serve_rev/@${DEVTOOLS_REVISION}/`)
/** Reusable build cache; only a complete graph is copied into lib. */
export const DEVTOOLS_CACHE = fileURLToPath(new URL(`../.cache/devtools/${DEVTOOLS_REVISION}/`, import.meta.url))

const ASSET_EXTENSION = /\.(?:js|css|json|wasm|svg|png|avif|webp|jpg|jpeg|gif|woff2?|ttf)(?:[?#].*)?$/iu

/** Literal CDN dependencies and references that require a runtime-specific resolver. */
export interface DevtoolsDependencies {
  readonly urls: URL[]
  readonly externalModules: string[]
  readonly dynamicImports: string[]
}

/** One verified resource in the complete, untrimmed input graph. */
export interface DevtoolsResource {
  readonly path: string
  readonly sha256: string
  readonly bytes: number
  readonly dependencies: string[]
  readonly externalModules: string[]
  readonly dynamicImports: string[]
}

/**
 * Resolve imports, CSS/HTML assets, and literal Worker/resource URLs inside one CDN resource.
 * @param source - Decoded JavaScript, CSS, or HTML.
 * @param file - Absolute URL of this resource.
 * @param root - Allowed version-specific CDN root.
 * @returns CDN resources plus explicitly recorded bare/Node imports and nonliteral imports.
 */
export function findDevtoolsDependencies(source: string, file: URL, root: URL): DevtoolsDependencies {
  const dependencies = new Map<string, URL>()
  const externalModules = new Set<string>()
  const dynamicImports = new Set<string>()
  const module = (reference: string): void => {
    if (reference.startsWith('node:') || (!reference.startsWith('.') && !reference.startsWith('/')
      && !/^https?:/u.test(reference))) externalModules.add(reference)
    else add(reference, file, true)
  }
  const add = (reference: string, base = file, required = false): void => {
    if (reference.startsWith('node:') || reference.startsWith('data:') || reference.startsWith('blob:')
      || reference.startsWith('#')) return
    if (!required && !ASSET_EXTENSION.test(reference)) return
    const url = new URL(reference, base)
    url.hash = ''
    if (url.origin !== root.origin || !url.pathname.startsWith(root.pathname)) {
      if (required) throw new Error(`DevTools dependency escapes the pinned revision: ${url.href}`)
      return
    }
    dependencies.set(url.href, url)
  }
  const css = (value: string): void => {
    for (const match of value.matchAll(/url\(\s*["']?([^\s"')]+)["']?\s*\)/giu)) add(match[1]!)
    for (const match of value.matchAll(/@import\s+["']([^"']+)["']/giu)) add(match[1]!, file, true)
  }
  if (file.pathname.endsWith('.html')) {
    for (const match of source.matchAll(/<(?:script|link|img)\b[^>]*?\b(?:src|href)=["']([^"']+)["']/giu)) {
      add(match[1]!, file, true)
    }
    css(source)
  } else if (file.pathname.endsWith('.css')) css(source)
  else if (file.pathname.endsWith('.js')) {
    const ast = ts.createSourceFile(file.pathname, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
    const localeLists = new Map<string, string[]>()
    let lighthouseLocaleTables = 0
    const visit = (node: ts.Node): void => {
      if (file.pathname.endsWith('/third_party/lighthouse/lighthouse-dt-bundle.js') && ts.isArrayLiteralExpression(node)
        && node.elements.every(ts.isStringLiteralLike)
        && node.elements.filter(ts.isStringLiteralLike).some(element => element.text.endsWith('.ctc.json'))
        && node.elements.filter(ts.isStringLiteralLike).every(element => element.text.endsWith('.json'))) {
        lighthouseLocaleTables++
        for (const element of node.elements.filter(ts.isStringLiteralLike)) {
          if (!element.text.endsWith('.ctc.json')) add(`./locales/${element.text}`, file, true)
        }
      }
      if (file.pathname.endsWith('/core/i18n/i18n.js') && ts.isVariableDeclaration(node)
        && ts.isIdentifier(node.name) && node.initializer !== undefined && ts.isArrayLiteralExpression(node.initializer)
        && node.initializer.elements.every(ts.isStringLiteralLike)) {
        localeLists.set(node.name.text, node.initializer.elements.filter(ts.isStringLiteralLike).map(element => element.text))
      }
      if (file.pathname.endsWith('/core/i18n/i18n.js') && ts.isNewExpression(node)
        && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'I18n'
        && node.arguments?.[0] !== undefined && ts.isIdentifier(node.arguments[0])) {
        const locales = localeLists.get(node.arguments[0].text)
        if (locales === undefined) throw new Error('DevTools supported locales must be declared before the I18n constructor')
        for (const locale of locales) add(`./locales/${locale}.json`, file, true)
      }
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
        && node.moduleSpecifier !== undefined && ts.isStringLiteralLike(node.moduleSpecifier)) {
        module(node.moduleSpecifier.text)
      }
      if (ts.isCallExpression(node) && node.arguments[0] !== undefined && ts.isStringLiteralLike(node.arguments[0])) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) module(node.arguments[0].text)
        else if (node.expression.getText(ast) === 'import.meta.resolve' && !node.arguments[0].text.endsWith('.css')) {
          add(node.arguments[0].text, file, true)
        }
      }
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
        && (node.arguments[0] === undefined || !ts.isStringLiteralLike(node.arguments[0]))) {
        dynamicImports.add(node.getText(ast))
      }
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL'
        && node.arguments?.[0] !== undefined && ts.isStringLiteralLike(node.arguments[0])
        && node.arguments[1]?.getText(ast) === 'import.meta.url') add(node.arguments[0].text)
      if (ts.isStringLiteralLike(node)) {
        if (node.text.startsWith('Images/')) add(node.text, root)
        if (file.pathname.endsWith('.css.js')) css(node.text)
      }
      ts.forEachChild(node, visit)
    }
    visit(ast)
    if (file.pathname.endsWith('/third_party/lighthouse/lighthouse-dt-bundle.js') && lighthouseLocaleTables !== 1) {
      throw new Error('DevTools Lighthouse bundle must declare one canonical locale filename table')
    }
  }
  return { urls: [...dependencies.values()], externalModules: [...externalModules], dynamicImports: [...dynamicImports] }
}

function localPath(url: URL, root: URL, directory: string): string {
  const relative = decodeURIComponent(url.pathname.slice(root.pathname.length))
  if (relative.split('/').some(part => part === '..' || part === '.' || part.includes('\\'))) {
    throw new Error(`Invalid DevTools resource path: ${url.href}`)
  }
  const path = resolve(directory, relative)
  if (!path.startsWith(`${resolve(directory)}${sep}`)) throw new Error(`DevTools resource escapes the cache: ${url.href}`)
  return path
}

async function fetchResource(url: URL): Promise<Uint8Array> {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(url, { headers: { 'accept-encoding': 'identity' }, signal: AbortSignal.timeout(30_000) })
      if (!response.ok) {
        await response.body?.cancel()
        if (attempt < 2 && (response.status === 429 || response.status >= 500)) continue
        throw new Error(`DevTools download failed: HTTP ${response.status} ${url.href}`)
      }
      return new Uint8Array(await response.arrayBuffer())
    } catch (error) {
      if (attempt < 2 && (error instanceof TypeError || (error instanceof Error && error.name === 'TimeoutError'))) continue
      throw new Error(`DevTools resource failed: ${url.href}`, { cause: error })
    }
  }
}

/**
 * Download the fixed frontend and literal dependency graph into the reusable cache.
 * @returns Cache directory and complete graph, before product-specific pruning.
 */
export async function downloadDevtools(): Promise<{ directory: string; files: DevtoolsResource[] }> {
  const queue: URL[] = []
  const seen = new Set<string>()
  const files: DevtoolsResource[] = []
  const enqueue = (url: URL): void => {
    if (seen.has(url.href)) return
    seen.add(url.href)
    queue.push(url)
  }
  for (const path of ['devtools_app.html', 'core/i18n/locales/en-US.json', 'core/i18n/locales/zh.json']) {
    enqueue(new URL(path, DEVTOOLS_CDN))
  }
  while (queue.length > 0) {
    const batch = queue.splice(0, 6)
    const results = await Promise.allSettled(batch.map(async (url) => {
      const path = localPath(url, DEVTOOLS_CDN, DEVTOOLS_CACHE)
      let bytes: Uint8Array
      try {
        bytes = await readFile(path)
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
        bytes = await fetchResource(url)
        await mkdir(dirname(path), { recursive: true })
        const temporary = `${path}.${process.pid}.partial`
        await writeFile(temporary, bytes)
        await rename(temporary, path)
      }
      const relative = url.pathname.slice(DEVTOOLS_CDN.pathname.length)
      const dependencies = /\.(?:js|css|html)$/u.test(url.pathname)
        ? findDevtoolsDependencies(new TextDecoder().decode(bytes), url, DEVTOOLS_CDN)
        : { urls: [], externalModules: [], dynamicImports: [] }
      files.push({ path: relative, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.byteLength,
        dependencies: dependencies.urls.map(dependency => dependency.pathname.slice(DEVTOOLS_CDN.pathname.length)),
        externalModules: dependencies.externalModules, dynamicImports: dependencies.dynamicImports })
      for (const dependency of dependencies.urls) enqueue(dependency)
    }))
    const failures = results.filter(result => result.status === 'rejected')
    if (failures.length > 0) throw new AggregateError(failures.map(result => result.reason), 'DevTools resource graph is incomplete')
    console.log(`DevTools ${DEVTOOLS_REVISION.slice(0, 12)}: ${files.length} files, ${queue.length} pending`)
  }
  const groups = new Map<string, { path: string; files: number; bytes: number }>()
  for (const file of files) {
    const parts = file.path.split('/')
    const key = file.path.startsWith('core/i18n/locales/') ? 'core/i18n/locales' : parts.slice(0, parts.length > 2 ? 2 : 1).join('/')
    const group = groups.get(key) ?? { path: key, files: 0, bytes: 0 }
    group.files++
    group.bytes += file.bytes
    groups.set(key, group)
  }
  await writeFile(resolve(DEVTOOLS_CACHE, 'resource-manifest.json'), `${JSON.stringify({
    chromium: DEVTOOLS_CHROMIUM_VERSION, revision: DEVTOOLS_REVISION, baseUrl: DEVTOOLS_CDN.href,
    totalFiles: files.length, totalBytes: files.reduce((total, file) => total + file.bytes, 0),
    groups: [...groups.values()].sort((left, right) => right.bytes - left.bytes),
    files: files.sort((left, right) => left.path.localeCompare(right.path)),
  }, null, 2)}\n`)
  return { directory: DEVTOOLS_CACHE, files }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await downloadDevtools()
