/** Copy the reachable, product-configured portion of the immutable DevTools CDN mirror. */
import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { DEVTOOLS_CDN, DEVTOOLS_CHROMIUM_VERSION, DEVTOOLS_REVISION, downloadDevtools, findDevtoolsDependencies } from './download-devtools.ts'
import { pruneLighthouse } from './prune-lighthouse.ts'

const DEVTOOLS_LOCALES = ['en-US', 'zh'] as const

/**
 * Keep the language menu, locale fallback, and resource graph on the same supported locales.
 * @param source - Original core/i18n module from the pinned CDN revision.
 * @returns Module with its supported-locale array restricted to the distributed languages.
 * @throws If the pinned input omits a configured locale or has no unique supported-locale array.
 */
export function configureDevtoolsLocales(source: string): string {
  const file = ts.createSourceFile('i18n.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const arrays = new Map<string, ts.ArrayLiteralExpression>()
  const selected: ts.ArrayLiteralExpression[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
      && node.initializer !== undefined && ts.isArrayLiteralExpression(node.initializer)) {
      arrays.set(node.name.text, node.initializer)
    }
    if (ts.isNewExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'I18n'
      && node.arguments?.[0] !== undefined && ts.isIdentifier(node.arguments[0])) {
      const array = arrays.get(node.arguments[0].text)
      if (array === undefined || !array.elements.every(ts.isStringLiteralLike)) {
        throw new Error('Pinned DevTools supported locales must be a literal string array')
      }
      const available = array.elements.filter(ts.isStringLiteralLike).map(element => element.text)
      if (DEVTOOLS_LOCALES.some(locale => !available.includes(locale))) {
        throw new Error('Pinned DevTools must include every distributed locale')
      }
      selected.push(array)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  if (selected.length !== 1) throw new Error('Pinned DevTools must declare one supported-locale array')
  const array = selected[0]!
  return source.slice(0, array.getStart(file)) + JSON.stringify(DEVTOOLS_LOCALES) + source.slice(array.end)
}

function replaceOne(source: string, before: string, after: string, subject: string): string {
  if (source.split(before).length !== 2) throw new Error(`Pinned DevTools ${subject} must occur exactly once`)
  return source.replace(before, after)
}

/**
 * Apply Host CPU-profiling mode without changing the Elements target or other panels.
 * @param source - Pinned Timeline module.
 * @returns Timeline code recording the existing Host CPUProfilerModel.
 */
export function configureHostPerformance(source: string): string {
  return replaceOne(replaceOne(source,
    '#o=rn.Runtime.Runtime.isNode();', '#o=true;', 'Performance mode'),
  'D.TargetManager.TargetManager.instance().targets().find(t=>t.type()===D.Target.Type.NODE)',
  'D.TargetManager.TargetManager.instance().primaryPageTarget()', 'Performance target')
}

/**
 * Build lib/devtools from the complete input graph, preserving relative module/Worker URLs.
 * @returns Published file count and bytes, excluding the distribution manifest.
 */
export async function buildDevtools(): Promise<{ files: number; bytes: number }> {
  const input = await downloadDevtools()
  const indexed = new Map(input.files.map(file => [file.path, file]))
  const output = new URL('../lib/devtools/', import.meta.url)
  const temporary = new URL(`../lib/devtools.build-${process.pid}/`, import.meta.url)
  await rm(temporary, { recursive: true, force: true })
  await mkdir(temporary, { recursive: true })
  const queue = ['devtools_app.html']
  const visited = new Set<string>()
  const nodeImports = new Set<string>()
  const files: { path: string; bytes: number; sha256: string }[] = []
  try {
    while (queue.length > 0) {
      const path = queue.pop()!
      if (visited.has(path)) continue
      visited.add(path)
      const descriptor = indexed.get(path)
      if (descriptor === undefined) throw new Error(`DevTools dependency was not indexed: ${path}`)
      const original = await readFile(join(input.directory, path))
      if (createHash('sha256').update(original).digest('hex') !== descriptor.sha256) {
        throw new Error(`DevTools cached resource changed: ${path}`)
      }
      let bytes: Uint8Array = original
      if (/\.(?:html|css|js)$/u.test(path)) {
        let source = pruneLighthouse(path, original.toString('utf8'))
        if (path === 'panels/timeline/timeline.js') source = configureHostPerformance(source)
        if (path === 'core/i18n/i18n.js') source = configureDevtoolsLocales(source)
        const dependencies = findDevtoolsDependencies(source, new URL(path, DEVTOOLS_CDN), DEVTOOLS_CDN)
        for (const dependency of dependencies.urls) queue.push(dependency.pathname.slice(DEVTOOLS_CDN.pathname.length))
        for (const specifier of dependencies.externalModules) if (specifier.startsWith('node:')) nodeImports.add(specifier)
        bytes = new TextEncoder().encode(source)
      }
      const target = new URL(path, temporary)
      await mkdir(new URL('./', target), { recursive: true })
      await writeFile(target, bytes)
      files.push({ path, bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') })
    }
    if (files.some(file => /(?:^|\/)lighthouse(?:\/|_)/u.test(file.path))) {
      throw new Error('Lighthouse remains reachable in the trimmed DevTools distribution')
    }
    const htmlPath = new URL('devtools_app.html', temporary)
    const html = await readFile(htmlPath, 'utf8')
    const imports = JSON.stringify({ imports: Object.fromEntries([...nodeImports].sort()
      .map(specifier => [specifier, './node-runtime-unavailable.js'])) })
    const hash = createHash('sha256').update(imports).digest('base64')
    if (!/script-src\s+/u.test(html)) throw new Error('DevTools entry must declare script-src')
    const preparedHtml = replaceOne(html.replace(/script-src\s+/u, `script-src 'sha256-${hash}' `),
      '<script type="module"', `<script type="importmap">${imports}</script><script src="./connect.js"></script><script type="module"`,
      'module entry')
    await writeFile(htmlPath, preparedHtml)
    const htmlRecord = files.find(file => file.path === 'devtools_app.html')!
    htmlRecord.bytes = Buffer.byteLength(preparedHtml)
    htmlRecord.sha256 = createHash('sha256').update(preparedHtml).digest('hex')
    for (const asset of ['connect.js', 'node-runtime-unavailable.js', 'LICENSE']) {
      await cp(new URL(`../assets/devtools/${asset}`, import.meta.url), new URL(asset, temporary))
      const bytes = await readFile(new URL(asset, temporary))
      files.push({ path: asset, bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') })
    }
    const bytes = files.reduce((total, file) => total + file.bytes, 0)
    await writeFile(new URL('resource-manifest.json', temporary), `${JSON.stringify({
      chromium: DEVTOOLS_CHROMIUM_VERSION, revision: DEVTOOLS_REVISION, source: DEVTOOLS_CDN.href,
      locales: DEVTOOLS_LOCALES, excludedFeatures: ['lighthouse'],
      files: files.sort((left, right) => left.path.localeCompare(right.path)),
    }, null, 2)}\n`)
    await rm(output, { recursive: true, force: true })
    await rename(fileURLToPath(temporary), fileURLToPath(output))
    console.log(`DevTools output: ${files.length} files, ${bytes} bytes`)
    return { files: files.length, bytes }
  } catch (error) {
    await rm(temporary, { recursive: true, force: true })
    throw error
  }
}
