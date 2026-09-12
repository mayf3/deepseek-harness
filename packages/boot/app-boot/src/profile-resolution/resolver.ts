/** In-memory profile package routing for Node's default ESM and CommonJS loaders. */

import { existsSync, realpathSync, statSync } from 'node:fs'
import { createRequire, isBuiltin } from 'node:module'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { getEnvironmentData, setEnvironmentData } from 'node:worker_threads'
import type { ModuleLoaderV1, ModuleLoaderV2, ResolveResult } from '@deepseek-ai/cordis-plugin-loader'
import { isProfileModuleFallbackLink } from './legacy-links.ts'
import type { ProfileResolutionEntry, ProfileResolutionGeneration } from '../profile.ts'

const WORKER_RESOLUTION_KEY = '@deepseek-ai/dsh-app-boot/profile-resolution'
const EMPTY_ATTRIBUTES: ImportAttributes = Object.freeze({})

interface CommonJsParent {
  filename?: string | null
  paths?: string[]
}

interface CommonJsOptions {
  paths?: string[]
  conditions?: ReadonlySet<string>
}

interface CommonJsModule {
  new(id?: string, parent?: CommonJsParent): CommonJsParent
  _nodeModulePaths(path: string): string[]
  _resolveFilename(
    request: string, parent: CommonJsParent | null | undefined, isMain: boolean, options?: CommonJsOptions,
  ): string
}

interface InternalModules {
  esm: ModuleLoaderV1 | ModuleLoaderV2
  cjs: CommonJsModule
  modern: boolean
}

type EsmResolve = (
  request: string, parent: string | undefined, attributes: ImportAttributes,
) => ResolveResult | Promise<ResolveResult>

type ResolutionRoute =
  | { readonly kind: 'fallback'; readonly entry: ProfileResolutionEntry }
  | { readonly kind: 'after-fallback'; readonly parent: string }
  | { readonly kind: 'native'; readonly packageDir?: string }

interface ResolutionRouteState {
  readonly route: ResolutionRoute
  packageDir?: string
  esm?: ResolveResult
  cjs?: string
}

interface ParentRoutes {
  readonly parent: string
  readonly profilesDir: string
  readonly activeProfile: boolean
  readonly requests: Map<string, ResolutionRouteState>
}

type ResolutionRoutes = Map<string, ParentRoutes | false>

interface CompiledGeneration {
  readonly entries: ReadonlyMap<string, ProfileResolutionEntry>
  readonly profilesDir: string
  readonly profileDir: string | undefined
  readonly profilePaths: readonly string[]
  readonly profileUrls: readonly string[]
  readonly profile: readonly string[]
  readonly activeProfileUrls: readonly string[]
  readonly localPackageNames: ReadonlySet<string>
  readonly shared: ReadonlySet<string>
  readonly esmRoutes: ResolutionRoutes
  readonly cjsRoutes: ResolutionRoutes
}

/** Whether runtime resolution redirects requests or verifies the materialized backend. */
export type ProfileResolutionBehavior = 'enforce' | 'verify'

/** Active resolver registration in one Node isolate. */
export interface ProfileResolutionRegistration {
  /**
   * Locate a bare package without requiring one of its exports.
   * @param specifier - bare package or package-subpath specifier.
   * @param parentURL - file URL whose lookup order applies.
   * @returns selected package directory, or undefined when it is absent.
   */
  packageDir(specifier: string, parentURL: string): string | undefined
  /**
   * Atomically publish an additive package table and fresh generation-owned caches.
   * @param generation - fully constructed successor generation.
   * @throws when the profile scope or an existing package mapping changes.
   */
  replace(generation: ProfileResolutionGeneration): void
  /** Restore the native resolver methods. Registrations dispose in reverse order. */
  dispose(): void
}

/**
 * Split a bare request into its package name without allocating path segments.
 * @param request - module specifier to classify.
 * @returns the bare package name, or undefined for non-package requests.
 */
export function barePackageName(request: string): string | undefined {
  if (!request || request[0] === '.' || request[0] === '/' || request[0] === '\\'
    || request[0] === '#' || request.includes(':') || isBuiltin(request)) return
  const first = request.indexOf('/')
  if (request[0] !== '@') return first < 0 ? request : request.slice(0, first)
  if (first < 0) return
  const second = request.indexOf('/', first + 1)
  return second < 0 ? request : request.slice(0, second)
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    // A generation may name a profile scope before that directory is materialized.
    return resolve(path)
  }
}

function prefixes(path: string): readonly string[] {
  const configured = resolve(path) + sep
  const canonical = canonicalPath(path) + sep
  return canonical === configured ? [configured] : [configured, canonical]
}

function compileGeneration(generation: ProfileResolutionGeneration): CompiledGeneration {
  const profilePaths = prefixes(generation.profilesDir)
  const profile = generation.profileDir === undefined ? [] : prefixes(generation.profileDir)
  return {
    entries: new Map(generation.entries.map(entry => [entry.name, entry])),
    profilesDir: generation.profilesDir,
    profileDir: generation.profileDir,
    profilePaths,
    profileUrls: profilePaths.map(path => pathToFileURL(path).href),
    profile,
    activeProfileUrls: profile.map(path => pathToFileURL(path).href),
    localPackageNames: new Set(generation.localPackageNames),
    shared: new Set(profilePaths.map(prefix => join(prefix, 'node_modules'))),
    esmRoutes: new Map(),
    cjsRoutes: new Map(),
  }
}

function startsWithin(path: string, roots: readonly string[]): boolean {
  for (const root of roots) {
    if (path.startsWith(root)) return true
  }
  return false
}

function nativePackageDir(parent: string, name: string): string | undefined {
  for (const searchPath of createRequire(parent).resolve.paths(name) as string[]) {
    const candidate = join(searchPath, name)
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
  return undefined
}

function localPackageCandidate(
  searchPath: string, name: string, flavor: 'esm' | 'cjs',
): { packageDir: string; canBeManagedLink: boolean } | undefined {
  const candidate = join(searchPath, name)
  const stat = statSync(candidate, { throwIfNoEntry: false })
  const found = flavor === 'esm'
    ? stat?.isDirectory() === true
    : stat?.isFile() === true
      || existsSync(join(candidate, 'package.json'))
      || ['.js', '.json', '.node'].some(extension => existsSync(candidate + extension))
      || ['index.js', 'index.json', 'index.node'].some(entry => existsSync(join(candidate, entry)))
  return found ? { packageDir: candidate, canBeManagedLink: stat !== undefined } : undefined
}

function sameResolution(left: string, right: string): boolean {
  if (left === right) return true
  const leftPath = left.startsWith('file:') ? fileURLToPath(left) : left
  const rightPath = right.startsWith('file:') ? fileURLToPath(right) : right
  return canonicalPath(leftPath) === canonicalPath(rightPath)
}

/** One mutable pointer to immutable generation data. */
class ResolutionRouter {
  private current: CompiledGeneration

  constructor(generation: ProfileResolutionGeneration) {
    this.current = compileGeneration(generation)
  }

  replace(generation: ProfileResolutionGeneration): void {
    const entries = new Map(generation.entries.map(entry => [entry.name, entry]))
    if (generation.profilesDir !== this.current.profilesDir
      || generation.profileDir !== this.current.profileDir) {
      throw new Error('profile resolution: a generation cannot change its profile scope')
    }
    for (const [name, current] of this.current.entries) {
      const next = entries.get(name)
      if (next === undefined
        || !sameResolution(current.packageDir, next.packageDir)
        || !sameResolution(current.declarer, next.declarer)
        || current.version !== next.version
        || current.scope !== next.scope) {
        throw new Error(`profile resolution: replacing ${JSON.stringify(name)} requires a process restart`)
      }
    }
    const localPackageNames = new Set(generation.localPackageNames)
    for (const name of this.current.localPackageNames) {
      if (!localPackageNames.has(name)) {
        throw new Error(`profile resolution: removing local package ${JSON.stringify(name)} requires a process restart`)
      }
    }
    for (const name of localPackageNames) {
      if (!this.current.localPackageNames.has(name) && this.current.entries.has(name)) {
        throw new Error(`profile resolution: overriding ${JSON.stringify(name)} locally requires a process restart`)
      }
    }
    this.current = compileGeneration(generation)
  }

  private routeScoped(
    request: string,
    parentRoutes: ParentRoutes,
    generation: CompiledGeneration,
    flavor: 'esm' | 'cjs',
  ): ResolutionRouteState | undefined {
    const { parent, profilesDir, requests } = parentRoutes
    const name = barePackageName(request)
    if (name === undefined) return undefined

    const target = generation.entries.get(name)
    for (const searchPath of createRequire(parent).resolve.paths(name) as string[]) {
      if (generation.shared.has(resolve(searchPath))) break
      const candidate = localPackageCandidate(searchPath, name, flavor)
      if (candidate !== undefined) {
        const legacy = candidate.canBeManagedLink && generation.profile.some(prefix => (
          candidate.packageDir === join(prefix, 'node_modules', name)
          && isProfileModuleFallbackLink(prefix.slice(0, -1), name)
        ))
        if (!legacy) {
          const state = {
            route: { kind: 'native' as const, packageDir: candidate.packageDir },
            packageDir: candidate.packageDir,
          }
          requests.set(request, state)
          return state
        }
      }
    }

    const eligible = target?.scope === 'installation'
      || (target?.scope === 'profile' && parentRoutes.activeProfile)
    const route: ResolutionRoute = eligible
      ? { kind: 'fallback', entry: target }
      : { kind: 'after-fallback', parent: join(dirname(profilesDir), 'package.json') }
    const state: ResolutionRouteState = { route }
    requests.set(request, state)
    return state
  }

  private routeLocalPackage(
    request: string, parentRoutes: ParentRoutes, generation: CompiledGeneration,
  ): ResolutionRouteState | undefined {
    const name = barePackageName(request)
    if (name === undefined || !parentRoutes.activeProfile || !generation.localPackageNames.has(name)) return undefined
    const state = { route: { kind: 'native' as const } }
    parentRoutes.requests.set(request, state)
    return state
  }

  routeUrl(request: string, parentURL: string): ResolutionRouteState | undefined {
    const generation = this.current
    let parentRoutes = generation.esmRoutes.get(parentURL)
    if (parentRoutes === false) return undefined
    const cached = parentRoutes?.requests.get(request)
    if (cached !== undefined) return cached
    if (parentRoutes === undefined) {
      const profileIndex = generation.profileUrls.findIndex(prefix => parentURL.startsWith(prefix))
      const activeProfileIndex = generation.activeProfileUrls.findIndex(prefix => parentURL.startsWith(prefix))
      if (profileIndex < 0 && activeProfileIndex < 0) {
        generation.esmRoutes.set(parentURL, false)
        return undefined
      }
      let parent: string
      try {
        parent = fileURLToPath(parentURL)
      } catch {
        generation.esmRoutes.set(parentURL, false)
        return undefined
      }
      const profileRoot = profileIndex >= 0
        ? generation.profilePaths[profileIndex]
        : generation.profile[activeProfileIndex]
      /* v8 ignore next -- one matching index was established above */
      if (profileRoot === undefined) return undefined
      parentRoutes = {
        parent,
        profilesDir: profileRoot.slice(0, -1),
        activeProfile: activeProfileIndex >= 0,
        requests: new Map(),
      }
      generation.esmRoutes.set(parentURL, parentRoutes)
    }
    const local = this.routeLocalPackage(request, parentRoutes, generation)
    if (local !== undefined) return local
    return this.routeScoped(request, parentRoutes, generation, 'esm')
  }

  routePath(request: string, parent: string): ResolutionRouteState | undefined {
    const generation = this.current
    let parentRoutes = generation.cjsRoutes.get(parent)
    if (parentRoutes === false) return undefined
    const cached = parentRoutes?.requests.get(request)
    if (cached !== undefined) return cached
    if (parentRoutes === undefined) {
      const profilesDir = generation.profilePaths.find(prefix => parent.startsWith(prefix))
      const activeProfile = generation.profile.find(prefix => parent.startsWith(prefix))
      if (profilesDir !== undefined || activeProfile !== undefined) {
        const profileRoot = profilesDir ?? activeProfile
        /* v8 ignore next -- one matching root was established above */
        if (profileRoot === undefined) return undefined
        parentRoutes = {
          parent,
          profilesDir: profileRoot.slice(0, -1),
          activeProfile: activeProfile !== undefined,
          requests: new Map(),
        }
        generation.cjsRoutes.set(parent, parentRoutes)
      }
    }
    if (parentRoutes === undefined) {
      generation.cjsRoutes.set(parent, false)
      return undefined
    }
    const local = this.routeLocalPackage(request, parentRoutes, generation)
    if (local !== undefined) return local
    return this.routeScoped(request, parentRoutes, generation, 'cjs')
  }

  explicitRoute(
    request: string, paths: readonly string[],
  ): { index: number; state: ResolutionRouteState } | undefined {
    for (const [index, path] of paths.entries()) {
      const parent = join(resolve(path), '.dsh-profile-resolution.cjs')
      const state = this.routePath(request, parent)
      if (state !== undefined) return { index, state }
    }
    return undefined
  }

  packageDir(specifier: string, parentURL: string): string | undefined {
    const name = barePackageName(specifier)
    if (name === undefined) return undefined
    const state = this.routeUrl(specifier, parentURL)
    if (state?.route.kind === 'fallback') return state.route.entry.packageDir
    if (state?.packageDir !== undefined) return state.packageDir
    let parent: string
    try {
      parent = state?.route.kind === 'after-fallback' ? state.route.parent : fileURLToPath(parentURL)
    } catch {
      return undefined
    }
    const found = nativePackageDir(parent, name)
    if (state !== undefined && found !== undefined) state.packageDir = found
    return found
  }
}

function internalModules(): InternalModules {
  const require = createRequire(import.meta.url)
  const addon = require('node-addon-require-builtin') as { requireBuiltin(moduleId: string): unknown }
  const esmModule = addon.requireBuiltin('internal/modules/esm/loader') as {
    getOrInitializeCascadedLoader(): ModuleLoaderV1 | ModuleLoaderV2
  }
  const cjsModule = addon.requireBuiltin('internal/modules/cjs/loader') as { Module: CommonJsModule }
  const esm = esmModule.getOrInitializeCascadedLoader()
  const modern = 'getOrCreateModuleJob' in esm
  /* v8 ignore start -- the supported Node 22/24/26 matrix validates each available Internal interface */
  if (typeof esm.resolveSync !== 'function'
    || typeof Reflect.get(esm, modern ? 'getOrCreateModuleJob' : 'getModuleJobForImport') !== 'function'
    || (!modern && typeof Reflect.get(esm, 'resolve') !== 'function')
    || typeof cjsModule.Module._resolveFilename !== 'function') {
    throw new Error('profile resolution: unsupported Node module loader')
  }
  /* v8 ignore stop */
  return { esm, cjs: cjsModule.Module, modern }
}

function assertEquivalent(actual: string, expected: string, request: string, parent: string): void {
  if (sameResolution(actual, expected)) return
  throw new Error(
    `profile resolution mismatch for ${JSON.stringify(request)} from ${parent}: disk resolved ${actual}, generation resolved ${expected}`,
  )
}

/**
 * Install one profile generation on Node's default ESM and CommonJS resolvers.
 * @param generation - complete package table and profile scope.
 * @param behavior - enforce the generation, or verify a materialized generation.
 * @returns a registration that replaces the generation or restores the native methods.
 */
export function installProfileResolution(
  generation: ProfileResolutionGeneration,
  behavior: ProfileResolutionBehavior = 'enforce',
): ProfileResolutionRegistration {
  const router = new ResolutionRouter(generation)
  const { esm, cjs, modern } = internalModules()
  const esmScope = new Map<string, boolean>()
  const profileUrls = [
    ...prefixes(generation.profilesDir),
    ...(generation.profileDir === undefined ? [] : prefixes(generation.profileDir)),
  ].map(path => pathToFileURL(path).href)
  let recentEsmParent: string | undefined
  let recentEsmScoped = false
  let delegatedEsm: { parent: string | undefined; request: string } | undefined

  const adaptEsm = (native: EsmResolve): EsmResolve => (request, parent, attributes) => {
    const delegated = delegatedEsm
    /* v8 ignore next -- reentry requires a separate synchronous Node hook; supported launches install none */
    if (delegated !== undefined && delegated.parent === parent && delegated.request === request) {
      return native(request, parent, attributes)
    }
    if (parent === undefined) return native(request, parent, attributes)
    let scoped = recentEsmParent === parent ? recentEsmScoped : esmScope.get(parent)
    if (scoped === undefined) {
      scoped = startsWithin(parent, profileUrls)
      esmScope.set(parent, scoped)
    }
    if (recentEsmParent !== parent) {
      recentEsmParent = parent
      recentEsmScoped = scoped
    }
    if (!scoped) return native(request, parent, attributes)
    const state = router.routeUrl(request, parent)
    if (state === undefined) return native(request, parent, attributes)
    const cacheable = attributes === EMPTY_ATTRIBUTES || Object.keys(attributes).length === 0
    if (cacheable && state.esm !== undefined) return state.esm
    const route = state.route
    if (route.kind === 'native') {
      const result = native(request, parent, attributes)
      if (cacheable && !(result instanceof Promise)) state.esm = result
      return result
    }
    const routedParent = pathToFileURL(route.kind === 'fallback' ? route.entry.declarer : route.parent).href
    if (behavior === 'enforce') {
      const previous = delegatedEsm
      delegatedEsm = { parent: routedParent, request }
      try {
        const result = native(request, routedParent, attributes)
        /* v8 ignore next -- Node 24+ resolves synchronously; the Node 22 matrix covers its Promise result */
        if (cacheable && !(result instanceof Promise)) state.esm = result
        return result
      } finally {
        delegatedEsm = previous
      }
    }
    const actual = native(request, parent, attributes)
    const previous = delegatedEsm
    delegatedEsm = { parent: routedParent, request }
    try {
      const expected = native(request, routedParent, attributes)
      /* v8 ignore start -- Node 22 is the asynchronous adapter and is covered by the external version matrix */
      if (expected instanceof Promise || actual instanceof Promise) {
        return Promise.all([actual, expected]).then(([resolved, wanted]) => {
          assertEquivalent(resolved.url, wanted.url, request, parent)
          if (cacheable) state.esm = resolved
          return resolved
        })
      }
      /* v8 ignore stop */
      assertEquivalent(actual.url, expected.url, request, parent)
      if (cacheable) state.esm = actual
      return actual
    } finally {
      delegatedEsm = previous
    }
  }

  let restoreEsm: () => void
  /* v8 ignore else -- CI coverage runs Node 24 v2; the Node 22 matrix exercises the v1 adapter */
  if (modern) {
    const loader = esm as ModuleLoaderV2
    const original = Reflect.get(loader, 'resolveSync')
    const resolveRequest = adaptEsm((request, parent, attributes) => original.call(
      loader, parent as string, { specifier: request, attributes },
    ))
    const wrapped = (parent: string, request: { specifier: string; attributes?: ImportAttributes }, ...rest: unknown[]): ResolveResult => (
      rest.length
        ? Reflect.apply(original, loader, [parent, request, ...rest]) as ResolveResult
        : resolveRequest(request.specifier, parent, request.attributes ?? EMPTY_ATTRIBUTES) as ResolveResult
    )
    loader.resolveSync = wrapped
    restoreEsm = () => {
      /* v8 ignore else -- registrations are disposed in reverse installation order */
      if (loader.resolveSync === wrapped) loader.resolveSync = original
    }
  } else {
    const loader = esm as ModuleLoaderV1
    const original = Reflect.get(loader, 'resolve')
    const originalSync = Reflect.get(loader, 'resolveSync')
    const resolveRequest = adaptEsm((request, parent, attributes) => original.call(loader, request, parent as string, attributes))
    const resolveRequestSync = adaptEsm((request, parent, attributes) => originalSync.call(loader, request, parent as string, attributes))
    const wrapped = (request: string, parent: string, attributes: ImportAttributes = EMPTY_ATTRIBUTES): Promise<ResolveResult> => (
      resolveRequest(request, parent, attributes) as Promise<ResolveResult>
    )
    const wrappedSync = (request: string, parent: string, attributes: ImportAttributes = EMPTY_ATTRIBUTES): ResolveResult => (
      resolveRequestSync(request, parent, attributes) as ResolveResult
    )
    loader.resolve = wrapped
    loader.resolveSync = wrappedSync
    restoreEsm = () => {
      if (loader.resolve === wrapped) loader.resolve = original
      if (loader.resolveSync === wrappedSync) loader.resolveSync = originalSync
    }
  }

  const originalFilename = Reflect.get(cjs, '_resolveFilename')
  let delegatedCjs = 0
  const resolveRoutedCjs = (
    request: string, routed: Exclude<ResolutionRoute, { kind: 'native' }>,
    parent: CommonJsParent, main: boolean, options?: CommonJsOptions,
  ): string => {
    const anchor = routed.kind === 'fallback' ? routed.entry.declarer : routed.parent
    const synthetic = new cjs(anchor, parent)
    synthetic.filename = anchor
    synthetic.paths = cjs._nodeModulePaths(dirname(anchor))
    return originalFilename.call(cjs, request, synthetic, main, options)
  }
  const wrappedFilename: CommonJsModule['_resolveFilename'] = (request, parent, main, options) => {
    if (delegatedCjs || !parent?.filename) {
      return originalFilename.call(cjs, request, parent, main, options)
    }
    const explicitPaths = Array.isArray(options?.paths) ? options.paths : undefined
    const explicit = explicitPaths === undefined ? undefined : router.explicitRoute(request, explicitPaths)
    if (options?.paths !== undefined && explicit === undefined) {
      return originalFilename.call(cjs, request, parent, main, options)
    }
    if (explicit !== undefined && explicitPaths !== undefined && explicit.index > 0) {
      try {
        return originalFilename.call(cjs, request, parent, main, {
          ...options,
          paths: explicitPaths.slice(0, explicit.index),
        })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw error
      }
    }
    const state = explicit?.state ?? router.routePath(request, parent.filename)
    if (state === undefined) return originalFilename.call(cjs, request, parent, main, options)
    const cacheable = options?.paths === undefined && options?.conditions === undefined
    if (cacheable && state.cjs !== undefined) return state.cjs
    const route = state.route
    if (route.kind === 'native') {
      const result = originalFilename.call(cjs, request, parent, main, options)
      if (cacheable) state.cjs = result
      return result
    }
    if (route.kind === 'after-fallback' && explicit !== undefined && explicitPaths !== undefined) {
      const paths = [...explicitPaths]
      paths[explicit.index] = dirname(route.parent)
      return originalFilename.call(cjs, request, parent, main, { ...options, paths })
    }
    delegatedCjs++
    try {
      const routedOptions = options?.conditions === undefined ? undefined : { conditions: options.conditions }
      const expected = resolveRoutedCjs(request, route, parent, main, routedOptions)
      if (behavior === 'enforce') {
        if (cacheable) state.cjs = expected
        return expected
      }
      const actual = originalFilename.call(cjs, request, parent, main, options)
      assertEquivalent(actual, expected, request, parent.filename)
      if (cacheable) state.cjs = actual
      return actual
    } finally {
      delegatedCjs--
    }
  }
  cjs._resolveFilename = wrappedFilename

  return {
    packageDir(specifier, parentURL) { return router.packageDir(specifier, parentURL) },
    replace(next) { router.replace(next) },
    dispose() {
      /* v8 ignore else -- registrations are disposed in reverse installation order */
      if (cjs._resolveFilename === wrappedFilename) cjs._resolveFilename = originalFilename
      restoreEsm()
    },
  }
}

/**
 * Publish one generation for Harness-owned Workers.
 * @param generation - complete package table and profile scope.
 * @param behavior - enforce or verify the generation in newly created Workers.
 * @param nativeCacheDir - private physical directory used to load the native adapter in a Worker.
 * @returns a disposer restoring the previous thread environment data.
 */
export function registerWorkerResolution(
  generation: ProfileResolutionGeneration,
  behavior: ProfileResolutionBehavior = 'enforce',
  nativeCacheDir?: string,
): () => void {
  const previous = getEnvironmentData(WORKER_RESOLUTION_KEY)
  setEnvironmentData(WORKER_RESOLUTION_KEY, {
    generation,
    behavior,
    ...(nativeCacheDir === undefined ? {} : { nativeCacheDir }),
  })
  return () => { setEnvironmentData(WORKER_RESOLUTION_KEY, previous) }
}
