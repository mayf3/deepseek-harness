/** Validate bundle display metadata, Node resource exports, and package publication selections. */

import { globSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, join, matchesGlob, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readPluginMeta, resolvePluginResource } from '../packages/boot/app-boot/src/package-meta.ts'

interface Manifest {
  name: string
  files?: string[]
  exports?: unknown
  icon?: unknown
  dsh?: { bundle?: { patch?: unknown } }
}

interface SourceJson {
  file: string
  metadata: boolean
  invalid: boolean
}

function sourceJsonFiles(dir: string): SourceJson[] {
  return globSync('**/*.json', { cwd: dir, exclude: ['node_modules', 'lib', 'tests'] }).map((path) => {
    const file = path.replaceAll('\\', '/')
    let contents: unknown
    try {
      contents = JSON.parse(readFileSync(join(dir, file), 'utf8'))
    } catch (_error) {
      return { file, metadata: false, invalid: true }
    }
    if (typeof contents !== 'object' || contents === null || Array.isArray(contents)) {
      return { file, metadata: false, invalid: true }
    }
    return { file, metadata: Object.hasOwn(contents, 'meta'), invalid: false }
  })
}

function targetsOf(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (typeof value !== 'object' || value === null) return []
  return Object.values(value).flatMap(targetsOf)
}

function rootLocaleTarget(file: string, exports: unknown): boolean {
  if (typeof exports !== 'object' || exports === null) return false
  return Object.entries(exports).some(([key, target]) => targetsOf(target).some((pattern) => {
    const index = pattern.indexOf('*')
    if (index < 0) return pattern === `./${file}` && /^\.\/locale\/[^/]+\.json$/u.test(key)
    const count = pattern.split('*').length - 1
    const source = `./${file}`
    const width = (source.length - pattern.length + count) / count
    if (width < 0 || !Number.isInteger(width)) return false
    const value = source.slice(index, index + width)
    return pattern.replaceAll('*', value) === source && /^\.\/locale\/[^/]+\.json$/u.test(key.replaceAll('*', value))
  }))
}

function published(file: string, files: string[]): boolean {
  const covered = (pattern: string): boolean => {
    const normalized = pattern.replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/+$/u, '')
    return normalized === '.' || normalized === ''
      || matchesGlob(file, normalized) || matchesGlob(file, `${normalized}/**`)
  }
  return files.some(pattern => !pattern.startsWith('!') && covered(pattern))
    && !files.some(pattern => pattern.startsWith('!') && covered(pattern.slice(1)))
}

function packageProblems(manifestPath: string): string[] {
  const problems: string[] = []
  const dir = realpathSync(dirname(manifestPath))
  const pkg = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest
  if (pkg.dsh?.bundle?.patch === undefined) return problems
  const documents = sourceJsonFiles(dir)
  const byPath = new Map(documents.map(document => [join(dir, document.file), document]))
  const parentURL = pathToFileURL(join(dir, 'package.json')).href
  const lookup = (resource: string): string | undefined => {
    try {
      return resolvePluginResource(resource, parentURL)
    } catch (_error) {
      // Missing exports and files are diagnosed against their source metadata below.
      return undefined
    }
  }
  const resourceOf = (filename: string): string => `${pkg.name}/locale/${filename}`
  const filenames = new Set(['en.json', ...documents.map(document => basename(document.file))])
  const resources = [...filenames].flatMap((filename) => {
    const file = lookup(resourceOf(filename))
    return file === undefined ? [] : [{ filename, file }]
  })
  const manifest = lookup(`${pkg.name}/package.json`)
  if (pkg.icon !== undefined && manifest !== join(dir, 'package.json')) {
    problems.push(`${manifestPath}: exports must expose its icon declaration through ${pkg.name}/package.json`)
  }
  const english = lookup(resourceOf('en.json'))
  const directory = english === undefined ? join(dir, 'locale') : dirname(english)
  const localeDocuments = documents.filter(document => dirname(join(dir, document.file)) === directory
    || (english === undefined && rootLocaleTarget(document.file, pkg.exports)))
  if (english === undefined && localeDocuments.some(document => document.metadata || document.invalid)) {
    problems.push(`${manifestPath}: exports must provide ${resourceOf('en.json')} as the locale discovery baseline`)
  }
  let sourceResources = true
  for (const { filename, file } of resources) {
    if (!byPath.has(file)) {
      problems.push(`${resourceOf(filename)}: locale metadata must resolve to source JSON, received ${file}`)
      sourceResources = false
    }
    if (dirname(file) !== directory) {
      problems.push(`${resourceOf(filename)}: ${file} must share the English locale directory ${directory}`)
    }
  }
  if (sourceResources) {
    const meta = readPluginMeta(pkg.name, parentURL)
    if (meta?.error !== undefined) problems.push(meta.error)
    if (meta?.icon !== undefined && typeof pkg.icon === 'string') {
      const iconFile = relative(dir, resolve(dir, pkg.icon)).replaceAll('\\', '/')
      if (pkg.files !== undefined && !published(iconFile, pkg.files)) problems.push(`${manifestPath}: files must include ${iconFile}`)
    }
  }
  for (const document of localeDocuments) {
    if (english === undefined && !document.metadata && !document.invalid) continue
    const resource = resourceOf(basename(document.file))
    const file = lookup(resource)
    if (file === undefined) {
      problems.push(`${manifestPath}: exports must expose ${resource} (${document.file})`)
    } else if (file !== join(dir, document.file)) {
      problems.push(`${manifestPath}: exports for ${resource} must resolve to ${document.file}, received ${relative(dir, file)}`)
    }
    if (pkg.files !== undefined && !published(document.file, pkg.files)) {
      problems.push(`${manifestPath}: files must include ${document.file}`)
    }
  }
  return problems
}

/**
 * Check bundle display resources without evaluating entries or requiring ordinary plugin JSON metadata.
 * @param root - repository or fixture root.
 * @returns diagnostics for an empty package corpus, invalid bundle metadata, inaccessible resources, or omitted publication files.
 */
export function packageMetaProblems(root: string): string[] {
  const manifests = globSync('packages/*/*/package.json', { cwd: root }).map(path => path.replaceAll('\\', '/'))
  if (manifests.length === 0) return [`${root}: no workspace package manifests found`]
  return manifests.flatMap(path => packageProblems(join(root, path)))
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = packageMetaProblems(resolve(import.meta.dirname, '..'))
  if (problems.length > 0) {
    console.error(problems.join('\n'))
    process.exitCode = 1
  } else {
    console.log('verify-package-meta: bundle metadata, resource exports, and publication files are valid.')
  }
}
