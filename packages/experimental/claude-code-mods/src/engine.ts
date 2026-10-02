/**
 * The mods engine: loaded mods and their hooks, engine-raised events, mods
 * API calls raised as events, per-session `$.state`, and the timers mods
 * start. It knows nothing of Cordis; the plugin supplies the engine behavior
 * for each mods API call and the test kit supplies stubs.
 * @module
 */

import type { BudgetClock, LoadedMod, RegisteredHook } from './chain.ts'
import { dispatch, ENGINE_ORIGIN } from './chain.ts'
import { createModsApi } from './api.ts'
import type { TimerHost } from './api.ts'
import { messageOf, record } from './values.ts'
import { HookRegistry } from './module.ts'
import type { ModsApi, OpResult, ModTimer } from './types.ts'

/** The engine behavior for one mods API call. */
export type OpCore<B> = (input: unknown, context: OpContext<B>) => unknown

/** Engine behaviors by event name, `<namespace>.<method>`. */
export type OpTable<B> = Readonly<Record<string, OpCore<B>>>

/** Looks up the engine behavior for one mods API call; `undefined` means none is served. */
export type OpResolver<B> = (op: string) => OpCore<B> | undefined

/**
 * Thrown by an engine behavior to answer a mods API call with `{ deny }`, so
 * the calling mod's `$` call rejects with the reason.
 */
export class OpDenied extends Error {
  constructor(readonly reason: string) {
    super(reason)
    this.name = 'OpDenied'
  }
}

/** What an op core and a `$` instance know about the raising hook's surroundings. */
export interface OpContext<B> {
  readonly mod: LoadedMod
  /** The engine-specific binding of the event that is running: the plugin's agent, or the test kit's fixture. */
  readonly binding: B
  readonly signal: AbortSignal
  readonly engine: ModsEngine<B>
}

/** Engine construction options. */
export interface ModsEngineOptions<B> {
  /**
   * Engine behaviors for mods API calls. The engine answers `state.*`,
   * `clock.now`, and `clock.sleep` itself when the resolver serves none.
   */
  readonly ops: OpResolver<B>
  /** The key `$.state` values live under: Claude Code's "for the whole session". */
  readonly stateKey: (binding: B) => string
  /** A hook's own running-time limit in milliseconds. */
  readonly budgetMs: number
  /** A `.catch` handler's running-time limit in milliseconds. */
  readonly catchBudgetMs: number
  /** Receives diagnostics: skipped hooks, failed fire-and-forget calls, timer callback errors. */
  readonly report: (line: string) => void
}

/** Options for raising one engine event. */
export interface RaiseOptions<B> {
  readonly binding: B
  readonly signal?: AbortSignal
}

const NEVER_ABORTS = new AbortController().signal

/** One named `$.state` slot: `<plugin>\u0000<key>`. */
function stateSlot(plugin: unknown, key: unknown): string {
  if (typeof plugin !== 'string' || typeof key !== 'string') throw new TypeError('$.state needs { plugin, key } strings')
  return `${plugin}\u0000${key}`
}

/** Timers owned by the engine on mods' behalf; disposal cancels them all. */
class TimerSet implements TimerHost {
  private readonly active = new Set<ReturnType<typeof setTimeout>>()

  constructor(private readonly report: (line: string) => void, private readonly owner: string) {}

  after(ms: number, fn: () => unknown): ModTimer {
    const handle = setTimeout(() => {
      this.active.delete(handle)
      this.run(fn)
    }, ms)
    handle.unref()
    this.active.add(handle)
    return { cancel: () => { clearTimeout(handle); this.active.delete(handle) } }
  }

  every(ms: number, fn: () => unknown): ModTimer {
    const handle = setInterval(() => { this.run(fn) }, ms)
    handle.unref()
    this.active.add(handle)
    return { cancel: () => { clearInterval(handle); this.active.delete(handle) } }
  }

  /** Cancel every timer still scheduled. */
  clear(): void {
    for (const handle of this.active) clearTimeout(handle)
    this.active.clear()
  }

  private run(fn: () => unknown): void {
    Promise.resolve().then(fn).catch((error: unknown) => {
      this.report(`${this.owner}: timer callback failed: ${messageOf(error)}`)
    })
  }
}

/**
 * Loaded mods, their hooks, and the two ways events reach them: the engine
 * raises one through every selected hook, and a mod's `$` call raises one
 * through the mods loaded before it.
 */
export class ModsEngine<B> {
  /** The loaded mods and their registrations. */
  readonly registry = new HookRegistry()
  private readonly state = new Map<string, Map<string, unknown>>()
  private readonly timers = new Map<string, TimerSet>()

  constructor(private readonly options: ModsEngineOptions<B>) {}

  /**
   * Raise one engine event through its hooks, outermost first.
   * @param event - the event name.
   * @param input - the event input; frozen before a hook sees it.
   * @param core - the engine behavior beneath every hook.
   * @param options - the binding events of this agent share, and its cancellation.
   * @returns the result as the outermost hook returned it.
   */
  raise<E, R>(event: string, input: E, core: (e: E) => Promise<R> | R, options: RaiseOptions<B>): Promise<R> {
    const signal = options.signal ?? NEVER_ABORTS
    return dispatch<E, R>({
      event,
      input,
      core,
      origin: ENGINE_ORIGIN,
      hooks: this.registry.select(event),
      api: (hook, clock) => this.api(hook.mod, clock, options.binding, signal),
      budgetMs: this.options.budgetMs,
      catchBudgetMs: this.options.catchBudgetMs,
      signal,
      report: this.options.report,
    })
  }

  /**
   * Raise one mods API call as its event through the mods loaded before the
   * caller, then answer it with the engine behavior.
   * @param mod - the calling mod.
   * @param op - the event name, `<namespace>.<method>`.
   * @param input - the call's input.
   * @param binding - the binding of the event the caller is handling.
   * @param signal - cancellation of that event.
   * @returns the value the chain answered with.
   * @throws Error with the reason when a hook or the engine answered `{ deny }`.
   */
  async invoke(mod: LoadedMod, op: string, input: unknown, binding: B, signal: AbortSignal): Promise<unknown> {
    const result = await dispatch<unknown, unknown>({
      event: op,
      input,
      core: async (e): Promise<OpResult> => {
        try {
          return { value: await this.opCore(op, e, { mod, binding, signal, engine: this }) }
        } catch (error: unknown) {
          if (error instanceof OpDenied) return { deny: error.reason }
          throw error
        }
      },
      origin: { plugin: mod.name, tier: 'user' },
      hooks: this.registry.select(op, mod),
      api: (hook, clock) => this.api(hook.mod, clock, binding, signal),
      budgetMs: this.options.budgetMs,
      catchBudgetMs: this.options.catchBudgetMs,
      signal,
      report: this.options.report,
    })
    // Hooks that settle with anything but an object are skipped, so the result is the core's or a hook's object.
    const answer = result as { value?: unknown; deny?: unknown }
    if (!('value' in answer) && !('deny' in answer)) throw new Error(`${op}: a hook returned neither { value } nor { deny }`)
    if (typeof answer.deny === 'string') throw new Error(`${op} refused: ${answer.deny}`)
    return answer.value
  }

  /**
   * Build the `$` for one mod inside one event.
   * @param mod - the mod the instance belongs to.
   * @param clock - the running hook's clock, or undefined outside a hook.
   * @param binding - the event's binding.
   * @param signal - the event's cancellation.
   * @returns the mods API.
   */
  api(mod: LoadedMod, clock: BudgetClock | undefined, binding: B, signal: AbortSignal): ModsApi {
    return createModsApi({
      mod,
      clock,
      invoke: (op, input) => this.invoke(mod, op, input, binding, signal),
      timers: this.timersOf(mod),
      report: this.options.report,
    })
  }

  /**
   * Forget one session's `$.state` values.
   * @param key - the session key the values were kept under.
   */
  forgetState(key: string): void {
    this.state.delete(key)
  }

  /**
   * The `claude plugin validate` style `hooks:` line for one mod.
   * @param mod - the loaded mod.
   * @returns its events with matchers, comma-separated.
   */
  describe(mod: LoadedMod): string {
    return this.registry.describe(mod)
  }

  /**
   * Drop one mod: its hooks stop receiving events and its timers are cancelled.
   * @param name - the plugin name.
   */
  unload(name: string): void {
    this.registry.remove(name)
    this.timers.get(name)?.clear()
    this.timers.delete(name)
  }

  /** Cancel every mod's timers and drop every registration. */
  dispose(): void {
    for (const mod of [...this.registry.list()]) this.unload(mod.name)
    this.state.clear()
  }

  private timersOf(mod: LoadedMod): TimerSet {
    let timers = this.timers.get(mod.name)
    if (timers === undefined) {
      timers = new TimerSet(this.options.report, mod.name)
      this.timers.set(mod.name, timers)
    }
    return timers
  }

  private opCore(op: string, input: unknown, context: OpContext<B>): unknown {
    const served = this.options.ops(op)
    if (served !== undefined) return served(input, context)
    const fields = record(input)
    switch (op) {
      case 'state.get': {
        const slot = stateSlot(fields.plugin, fields.key)
        return { value: this.state.get(this.options.stateKey(context.binding))?.get(slot) }
      }
      case 'state.set': {
        const slot = stateSlot(fields.plugin, fields.key)
        const key = this.options.stateKey(context.binding)
        let values = this.state.get(key)
        if (values === undefined) {
          values = new Map()
          this.state.set(key, values)
        }
        values.set(slot, fields.value)
        return undefined
      }
      case 'clock.now':
        return Date.now()
      case 'clock.sleep': {
        const ms = fields.ms
        if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) throw new TypeError('$.clock.sleep needs a non-negative number of milliseconds')
        return new Promise<void>((resolve) => { setTimeout(resolve, ms) })
      }
      default:
        throw new Error(`no implementation for ${op}`)
    }
  }
}

export type { RegisteredHook }
