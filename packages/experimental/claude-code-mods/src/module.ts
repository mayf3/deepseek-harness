/**
 * Hooks-module loading: import the module Node-side, run its `register(on,
 * options)`, and keep every `on(...)` registration in one ordered registry
 * that dispatch selects from.
 * @module
 */

import { pathToFileURL } from 'node:url'
import type { LoadedMod, RegisteredHook } from './chain.ts'
import { messageOf } from './values.ts'
import { describeMatcher, eventMatches, isEventPattern } from './matcher.ts'
import type { ModDirectory } from './manifest.ts'
import type { AnyHook, HooksModule, HookMatcher, ModOn, PluginOptions, HookRegistration } from './types.ts'

/** Mods ordered by load; hooks ordered by mod, then by registration. */
export class HookRegistry {
  private readonly hooks: RegisteredHook[] = []
  private readonly mods: LoadedMod[] = []

  /**
   * The loaded mods.
   * @returns the mods in load order.
   */
  list(): readonly LoadedMod[] {
    return this.mods
  }

  /**
   * Add one mod and its registrations; a mod of the same name must be removed first.
   * @param mod - the mod the hooks belong to.
   * @param hooks - its registrations in `on` order.
   */
  add(mod: LoadedMod, hooks: readonly RegisteredHook[]): void {
    if (this.mods.some(loaded => loaded.name === mod.name)) {
      throw new Error(`hooks module ${mod.name} not loaded: another plugin of that name loads first`)
    }
    this.mods.push(mod)
    this.hooks.push(...hooks)
  }

  /**
   * Drop one mod and its hooks.
   * @param name - the plugin name.
   */
  remove(name: string): void {
    const index = this.mods.findIndex(mod => mod.name === name)
    if (index === -1) return
    const [mod] = this.mods.splice(index, 1)
    for (let i = this.hooks.length - 1; i >= 0; i -= 1) {
      if (this.hooks[i]?.mod === mod) this.hooks.splice(i, 1)
    }
  }

  /**
   * Hooks whose pattern selects `event`, outermost first. A mods API call a mod
   * raised is seen only by the mods loaded before it.
   * @param event - the event name.
   * @param raisedBy - the mod whose `$` call became the event, or undefined for the engine.
   * @returns the ordered hooks; matchers are evaluated at run time.
   */
  select(event: string, raisedBy?: LoadedMod): RegisteredHook[] {
    return this.hooks
      .filter(hook => (raisedBy === undefined || hook.mod.order < raisedBy.order) && eventMatches(hook.event, event))
      .sort((left, right) => left.mod.order - right.mod.order)
  }

  /**
   * Event names with matchers, as `claude plugin validate` prints the `hooks:` line.
   * @param mod - the loaded mod.
   * @returns its events with matchers, comma-separated.
   */
  describe(mod: LoadedMod): string {
    return this.hooks
      .filter(hook => hook.mod === mod)
      .map(hook => `${hook.event}${describeMatcher(hook.matcher)}`)
      .join(', ')
  }
}

function isMatcher(value: unknown): value is HookMatcher {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Build the `on` function one `register` call receives and collect its
 * registrations. Validation follows Claude Code: the event name must be a
 * known name or glob, and one event may be registered without a matcher only
 * once.
 * @param mod - the mod registering.
 * @returns `on` and the list it appends to.
 */
export function createOn(mod: LoadedMod): { on: ModOn; hooks: RegisteredHook[] } {
  const hooks: RegisteredHook[] = []
  const unmatched = new Set<string>()
  const on = ((event: unknown, matcherOrHook: unknown, maybeHook?: unknown): HookRegistration => {
    if (typeof event !== 'string') throw new TypeError(`${mod.name}: the event name passed to on() is not a string literal`)
    if (!isEventPattern(event)) throw new Error(`${mod.name}: "${event}" is not an event`)
    const hook = maybeHook ?? matcherOrHook
    const matcher = maybeHook === undefined ? undefined : matcherOrHook
    if (typeof hook !== 'function') throw new TypeError(`${mod.name}: on("${event}") needs a hook function`)
    if (matcher !== undefined && !isMatcher(matcher)) throw new TypeError(`${mod.name}: on("${event}") matcher must be an object`)
    if (matcher === undefined) {
      if (unmatched.has(event)) throw new Error(`${mod.name}: on("${event}") is registered twice without a matcher`)
      unmatched.add(event)
    }
    const registered: RegisteredHook = {
      mod, event, matcher, hook: hook as AnyHook, catchHandler: undefined, reported: new Set(),
    }
    hooks.push(registered)
    return {
      catch(handler: AnyHook): void {
        if (typeof handler !== 'function') throw new TypeError(`${mod.name}: on("${event}").catch needs a handler function`)
        registered.catchHandler = handler
      },
    }
  }) as ModOn
  return { on, hooks }
}

/** Distinguishes one import of a module path from the next, so every load evaluates the module afresh. */
let loadCounter = 0

/**
 * Import one validated mod directory's hooks module and run `register`. Every
 * load evaluates the module anew, as a Claude Code reload does, so module-level
 * variables start over.
 * @param directory - the validated plugin directory.
 * @param options - the resolved `options` argument of `register`.
 * @param order - the mod's load order.
 * @returns the loaded mod and its registrations.
 */
export async function loadHooksModule(
  directory: ModDirectory,
  options: PluginOptions,
  order: number,
): Promise<{ mod: LoadedMod; hooks: RegisteredHook[] }> {
  const { manifest } = directory
  const mod: LoadedMod = Object.freeze({
    name: manifest.name,
    version: manifest.version,
    root: directory.root,
    modulePath: directory.modulePath,
    options,
    order,
  })
  let namespace: unknown
  try {
    loadCounter += 1
    namespace = await import(`${pathToFileURL(directory.modulePath).href}?load=${loadCounter}`)
  } catch (error: unknown) {
    throw new Error(`${manifest.name}: hooks module did not load: ${messageOf(error)}`, { cause: error })
  }
  const register = (namespace as Partial<HooksModule> | null)?.register
  if (typeof register !== 'function') {
    throw new Error(`${manifest.name}: hooks module did not load: ${directory.modulePath} does not export a register function`)
  }
  const { on, hooks } = createOn(mod)
  try {
    await register(on, options)
  } catch (error: unknown) {
    throw new Error(`${manifest.name}: hooks module did not load: register threw ${messageOf(error)}`, { cause: error })
  }
  return { mod, hooks }
}
