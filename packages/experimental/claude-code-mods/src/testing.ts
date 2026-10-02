/**
 * A test kit in the spirit of `claude-code/testing`: load mods from
 * directories or inline modules, register stubs that answer in the engine's
 * place beneath every mod, and raise events through the mods' hooks — no
 * session, agent, or harness service involved.
 * @module
 */

import { resolve } from 'node:path'
import type { LoadedMod } from './chain.ts'
import { ModsEngine, OpDenied } from './engine.ts'
import type { OpCore } from './engine.ts'
import { readModManifest, resolvePluginOptions } from './manifest.ts'
import { createOn, loadHooksModule } from './module.ts'
import type {
  CommandRunInput, CommandRunResult, ModsApi, PluginOptions, PromptSubmitInput, PromptSubmitResult, ModRegister,
  SessionEndInput, SessionEndResult, SessionStartInput, SessionStartResult, ToolCallInput, ToolCallResult,
  TurnCompleteInput, TurnCompleteResult, TurnStartInput, TurnStartResult,
} from './types.ts'

/** A mod written inline for a test instead of read from a directory. */
export interface TestModule {
  readonly name: string
  readonly register: ModRegister
  readonly options?: PluginOptions
}

/**
 * A stub answering one event in the engine's place. For an engine event it
 * returns that event's result; for a mods API call it returns `{ value }` or
 * `{ deny }`, and `undefined` from either reads as "not answered".
 */
export type StubHook = ($: ModsApi, e: never) => unknown

/** Test kit construction options. */
export interface ModTestKitOptions {
  /** Plugin directories to load, in chain order. A relative path resolves against `cwd`. */
  readonly dirs?: readonly string[]
  /** Inline mods, loaded after `dirs` in the given order. */
  readonly modules?: readonly TestModule[]
  /** Base for relative `dirs`; defaults to the process cwd. */
  readonly cwd?: string
  /** `register` option values by plugin name, overlaid on manifest `userConfig` defaults. */
  readonly options?: Readonly<Record<string, PluginOptions>>
  /** A hook's own running-time limit in milliseconds; defaults to 5 seconds, Claude Code's test limit. */
  readonly budgetMs?: number
}

/** The engine's own `$`-shaped raisers: each sends its event through the mods and resolves to the result. */
export interface TestKitRaisers {
  readonly tool: { call(input: Omit<ToolCallInput, 'tool_use_id'> & { tool_use_id?: string }): Promise<ToolCallResult> }
  readonly command: { run(input: Pick<CommandRunInput, 'command' | 'args'>): Promise<CommandRunResult> }
  readonly prompt: { submit(input: Pick<PromptSubmitInput, 'text'> & Partial<PromptSubmitInput>): Promise<PromptSubmitResult> }
  readonly session: {
    start(input: SessionStartInput): Promise<SessionStartResult>
    end(input: SessionEndInput): Promise<SessionEndResult>
  }
  readonly turn: {
    start(input: TurnStartInput): Promise<TurnStartResult>
    complete(input: TurnCompleteInput): Promise<TurnCompleteResult>
  }
}

/** A loaded test kit. */
export interface ModTestKit {
  /** Register a stub that answers `event` beneath every mod; name a mods API call without the `$.`. */
  on(event: string, stub: StubHook): void
  /** Raise any event through the mods; a stub, a built-in default, or `no implementation for <event>` answers at the bottom. */
  raise<R>(event: string, input: unknown): Promise<R>
  /** Typed raisers for the events this bridge sends from the harness. */
  readonly $: TestKitRaisers
  /** Diagnostic lines the engine reported: skipped hooks, failed fire-and-forget calls, timer errors. */
  readonly reports: string[]
  /** The loaded mods in chain order. */
  readonly mods: readonly LoadedMod[]
  /**
   * Drop every registration and close every mod timer.
   * @returns settles once running timer callbacks have finished.
   */
  dispose(): Promise<void>
}

/** Stubs that answer a whole namespace from memory. */
export const mock = Object.freeze({
  /**
   * Answer `$.store` from an in-memory map.
   * @param on - the kit's `on`.
   * @param initial - entries the store starts with.
   * @returns the live map, to read what the mod saved.
   */
  store(on: ModTestKit['on'], initial: Readonly<Record<string, unknown>> = {}): Map<string, unknown> {
    const saved = new Map(Object.entries(initial))
    on('store.get', (_$, e: { key: string }) => ({ value: saved.get(e.key) }))
    on('store.set', (_$, e: { key: string; value: unknown }) => {
      saved.set(e.key, e.value)
      return { value: undefined }
    })
    on('store.delete', (_$, e: { key: string }) => {
      saved.delete(e.key)
      return { value: undefined }
    })
    on('store.keys', () => ({ value: [...saved.keys()] }))
    return saved
  },
  /**
   * Answer `$.env.get` from fixed variables and record `$.env.set` writes.
   * @param on - the kit's `on`.
   * @param variables - the environment the mod sees.
   * @returns the live record, to read what the mod set.
   */
  env(on: ModTestKit['on'], variables: Readonly<Record<string, string>> = {}): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = { ...variables }
    on('env.get', (_$, e: { name: string }) => ({ value: env[e.name] }))
    on('env.set', (_$, e: { name: string; value?: string }) => {
      env[e.name] = e.value
      return { value: undefined }
    })
    return env
  },
})

/** Engine events whose default answer mirrors Claude Code's test-kit table when no stub is registered. */
const DEFAULT_ENGINE_ANSWERS: Readonly<Record<string, (e: never) => unknown>> = {
  'session.start': (e: SessionStartInput) => ({ cwd: e.cwd }),
  'session.end': (e: SessionEndInput) => ({ sessionId: e.sessionId }),
  'turn.start': (e: TurnStartInput) => ({ turnId: e.turnId }),
  'turn.complete': () => ({ text: '' }),
  'prompt.submit': (e: PromptSubmitInput) => ({ text: e.text, ...e.context === undefined ? {} : { context: e.context } }),
  'command.run': () => ({}),
}

/** Mods API calls the kit answers itself, as Claude Code's kit does. */
const DEFAULT_OP_ANSWERS: Readonly<Record<string, StubHook>> = {
  'ui.invalidate': () => ({ value: undefined }),
}

/**
 * Load mods for a test and return the kit.
 * @param options - the mods to load and the hook time limit.
 * @returns the kit, with every mod's `register` already run.
 */
export async function createModTestKit(options: ModTestKitOptions = {}): Promise<ModTestKit> {
  const reports: string[] = []
  const stubs = new Map<string, StubHook>()
  const cwd = options.cwd ?? process.cwd()
  const engine = new ModsEngine<Record<never, never>>({
    ops: (op) => {
      const stub = stubs.get(op) ?? DEFAULT_OP_ANSWERS[op]
      return stub === undefined ? undefined : opStub(op, stub)
    },
    stateKey: () => 'test',
    budgetMs: options.budgetMs ?? 5_000,
    catchBudgetMs: 1_000,
    report: (line) => { reports.push(line) },
  })
  const kitMod: LoadedMod = Object.freeze({
    name: 'claude-code-testing', version: undefined, root: cwd, modulePath: '', options: Object.freeze({}), order: Number.MAX_SAFE_INTEGER,
  })
  const binding = {}
  const signal = new AbortController().signal

  function opStub(op: string, stub: StubHook): OpCore<Record<never, never>> {
    return async (input) => {
      const answer = await stub(engine.api(kitMod, undefined, binding, signal), input as never)
      if (typeof answer !== 'object' || answer === null) throw new Error(`${op}: a stub returned neither { value } nor { deny }`)
      const result = answer as { value?: unknown; deny?: unknown }
      if (typeof result.deny === 'string') throw new OpDenied(result.deny)
      if (!('value' in result)) throw new Error(`${op}: a stub returned neither { value } nor { deny }`)
      return result.value
    }
  }

  let order = 0
  for (const dir of options.dirs ?? []) {
    const directory = readModManifest(resolve(cwd, dir), cwd)
    const resolved = resolvePluginOptions(directory.manifest, options.options?.[directory.manifest.name])
    const { mod, hooks } = await loadHooksModule(directory, resolved, order)
    engine.registry.add(mod, hooks)
    order += 1
  }
  for (const module of options.modules ?? []) {
    const mod: LoadedMod = Object.freeze({
      name: module.name, version: undefined, root: cwd, modulePath: `<inline ${module.name}>`,
      options: Object.freeze({ ...module.options, ...options.options?.[module.name] }), order,
    })
    const { on, hooks } = createOn(mod)
    await module.register(on, mod.options)
    engine.registry.add(mod, hooks)
    order += 1
  }

  function raise<R>(event: string, input: unknown): Promise<R> {
    return engine.raise<unknown, R>(event, input, async (e) => {
      const stub = stubs.get(event)
      if (stub !== undefined) {
        const answer = await stub(engine.api(kitMod, undefined, binding, signal), e as never)
        if (typeof answer !== 'object' || answer === null) throw new Error(`${event}: the stub returned no result`)
        return answer as R
      }
      const fallback = DEFAULT_ENGINE_ANSWERS[event]
      if (fallback === undefined) throw new Error(`no implementation for ${event}`)
      return fallback(e as never) as R
    }, { binding, signal })
  }

  let calls = 0
  return {
    on(event, stub) {
      stubs.set(event, stub)
    },
    raise,
    $: {
      tool: {
        call: input => raise<ToolCallResult>('tool.call', { tool_use_id: `test-${++calls}`, ...input }),
      },
      command: {
        run: input => raise<CommandRunResult>('command.run', { ...input, origin: { kind: 'composer' } }),
      },
      prompt: {
        submit: input => raise<PromptSubmitResult>('prompt.submit', { wait: false, origin: { kind: 'composer' }, ...input }),
      },
      session: {
        start: input => raise<SessionStartResult>('session.start', input),
        end: input => raise<SessionEndResult>('session.end', input),
      },
      turn: {
        start: input => raise<TurnStartResult>('turn.start', input),
        complete: input => raise<TurnCompleteResult>('turn.complete', input),
      },
    },
    reports,
    get mods() {
      return engine.registry.list()
    },
    dispose() {
      return engine.dispose()
    },
  }
}
