/**
 * Registration: the General row, the settings section, the new-session chip,
 * and the header label all come from one apply, and each defers until the slot
 * it fills has been declared. A pushed settings change refreshes the surfaces
 * that are already showing, so a default set from one converges the other.
 */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { RemoteError, TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { SessionId } from '@deepseek-ai/dsh-session'
import { apply as settingsApply, inject as settingsInject } from '@deepseek-ai/dsh-client-ui-settings/client'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-agent-preset/client'
import { AgentPresetLabel } from '../src/client/AgentPresetLabel.tsx'
import type { AgentPresetLabelInjected } from '../src/client/AgentPresetLabel.tsx'
import { AgentPresetSection } from '../src/client/AgentPresetSection.tsx'
import type { AgentPresetSectionInjected } from '../src/client/AgentPresetSection.tsx'
import { AgentPresetSeat } from '../src/client/AgentPresetSeat.tsx'
import type { AgentPresetSeatInjected } from '../src/client/AgentPresetSeat.tsx'
import { AgentPresetSeatController } from '../src/client/seat-store.ts'
import { CreatePluginMenuItem, type CreatePluginMenuItemInjected } from '../src/client/CreatePluginMenuItem.tsx'
import { apply as hostApply } from '../src/index.ts'
import type { AgentPresetRow } from '@deepseek-ai/dsh-agent-preset-registry/types'

// These specs assert the shipped Chinese copy. The lane has no jsdom `window`,
// so browser-language detection never runs and a fresh LocaleRuntime opens on
// FALLBACK_LOCALE (en); each bench stages zh explicitly on the locale instead.

/** The Developer tools half of `ctx.configForms`, which filters preset choices. */
function developerTools(enabled = true): { configForms: { developerTools: { enabled: ObservableSnapshot<boolean> } } } {
  return { configForms: { developerTools: { enabled: createSnapshotStore(enabled) } } }
}

const ROSTER_ONE = {
  ok: true as const,
  value: {
    presets: [{ id: 'standard', isDefault: true }],
  },
}

/** The roster after this browser copied one preset of its own. */
const ROSTER_AUTHORED = {
  ok: true as const,
  value: {
    presets: [
      { id: 'standard', isDefault: true },
      { id: 'mine', isDefault: false },
    ],
  },
}

/** The same roster with a second preset carrying the default. */
const ROSTER_MOVED = {
  ok: true as const,
  value: {
    presets: [
      { id: 'standard', isDefault: false },
      { id: 'minimal', isDefault: true },
    ],
  },
}

async function bench(options: {
  failSettingsUpdate?: boolean
  selectGate?: Promise<void>
  settingsRosterGate?: Promise<undefined>
  describeGate?: Promise<undefined>
  presets?: AgentPresetRow[]
  developerToolsEnabled?: boolean
  memory?: boolean
} = {}) {
  const ctx = new Context()
  // The host's answer, mutable so a spec can move the default the way the
  // settings surface does and watch who re-reads it.
  let ROSTER: { ok: true; value: { presets: AgentPresetRow[] } } = options.presets === undefined
    ? ROSTER_ONE : { ok: true, value: { presets: options.presets } }
  const moveDefault = (): void => { ROSTER = ROSTER_MOVED }
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  const calls: string[] = []
  let savedDefault = ROSTER.value.presets.find(row => row.isDefault)?.id ?? 'standard'
  let presetRevision = 0
  let developerToolsEnabled = options.developerToolsEnabled ?? true
  let settingsSaved = false
  const settingsRosterStarted = Promise.withResolvers<undefined>()
  // The row reads `describe` to learn whether this browser may write at all,
  // and its default write is the one op this spec records.
  const settings = {
    describe: () => Promise.resolve(options.describeGate).then(() => ({
      ok: true as const,
      value: {
        writable: true,
        hasDocument: true,
        // The shared Developer tools preference the surfaces read: this browser
        // has it on, so the roster is editable.
        namespaces: [{
          ns: 'ui-settings',
          schema: { type: 'object', dict: { enabled: { type: 'boolean' } } },
          value: { enabled: developerToolsEnabled },
          autoGenerate: false,
          applies: 'live',
          secrets: [],
          revision: 0,
        }, {
          ns: 'agent-preset-registry',
          schema: { type: 'object', dict: { selectedDefault: { type: 'string', meta: {} } } },
          value: { selectedDefault: savedDefault },
          autoGenerate: false,
          applies: 'live',
          secrets: [],
          revision: presetRevision,
        }],
      },
    })),
    update: (_ns: string, patch: { selectedDefault?: unknown }) => {
      calls.push(`settings:${JSON.stringify(patch)}`)
      if (options.failSettingsUpdate === true) {
        return Promise.resolve({
          ok: false as const,
          error: new RemoteError('gateway/internal', 'settings write disconnected', {}),
        })
      }
      if (typeof patch.selectedDefault === 'string') {
        savedDefault = patch.selectedDefault
      }
      presetRevision += 1
      ROSTER = options.presets === undefined ? savedDefault === 'minimal' ? ROSTER_MOVED : ROSTER_ONE
        : { ok: true, value: { presets: ROSTER.value.presets.map(row => ({ ...row, isDefault: row.id === savedDefault })) } }
      settingsSaved = true
      return Promise.resolve({ ok: true as const, value: {} })
    },

  }
  const remote = new TestRemote(ctx, { settings })
  if (options.memory === true) remote.$host = { home: undefined, isLoopback: false }
  // The roster and the switch are the AgentPresets Remote namespace; the
  // shared double carries no generated namespaces, so this spec stages its
  // own. Registered twice on purpose: the nested key satisfies the plugin's
  // `inject`, and the property is what `ctx.remote.agentPresets` reads,
  // because the double is a plain provided object rather than a Service.
  const agentPresets = {
    list: () => {
      calls.push('list')
      if (settingsSaved) {
        settingsRosterStarted.resolve(undefined)
        if (options.settingsRosterGate !== undefined) return options.settingsRosterGate.then(() => ROSTER)
      }
      return Promise.resolve(ROSTER)
    },
    read: (id: string) => Promise.resolve({
      ok: true as const,
      value: { agentPreset: id, content: `# ${id}\n[]\n` },
    }),
    save: (id: string) => {
      calls.push(`save:${id}`)
      // The host's roster now contains it, which is the whole point of the
      // save and what every surface must converge on.
      ROSTER = ROSTER_AUTHORED
      return Promise.resolve({ ok: true as const, value: { saved: true } })
    },
    select: (agentId: SessionId, agentPreset: string) => {
      calls.push(`select:${agentPreset}`)
      return Promise.resolve(options.selectGate).then(() => {
        remote.emit('agent-preset/selected', [agentId, agentPreset])
        return { ok: true as const, value: agentPreset }
      })
    },
  }
  ctx.provide('remote.agentPresets', agentPresets as never)
  Object.assign(remote, { agentPresets })
  await ctx.plugin({ inject: [...settingsInject], apply: settingsApply }).await()
  if (options.describeGate === undefined) {
    await vi.waitFor(() => {
      expect(ctx.configForms.developerTools.enabled.getSnapshot()).toBe(options.memory === true ? true : developerToolsEnabled)
    })
    if (options.memory !== true) await vi.waitFor(() => { expect(ctx.configForms.get('ui-settings').getSnapshot().status).toBe('ready') })
  }
  /** Publish a new Developer tools choice the way the settings mirror does. */
  const setDeveloperTools = async (enabled: boolean): Promise<void> => {
    developerToolsEnabled = enabled
    remote.emit('settings/document-updated', ['ui-settings', 1])
    await vi.waitFor(() => { expect(ctx.configForms.developerTools.enabled.getSnapshot()).toBe(enabled) })
  }
  return {
    ctx, slots: ctx.get('slots') as SlotRegistry, calls, moveDefault, remote,
    settingsRosterStarted: settingsRosterStarted.promise, setDeveloperTools,
  }
}

function declareRoot(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: {
      'settings.general.item': { kind: 'list', scope: 'root' },
      'settings.section': { kind: 'list', scope: 'root' },
      conversation: { kind: 'single', scope: 'root' },
    },
  } as never, () => null)
}

/** The conversation's own declarations, which the chip and label wait for. */
function declareConversation(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'conversation',
    children: {
      'conversation.hero.agentPreset': { kind: 'single', scope: 'session-maybe' },
      'conversation.session.header.actions': { kind: 'list', scope: 'session' },
    },
  } as never, () => null)
}

/** A Workspace UI double recording new-session starts. */
function uiWorkspaceDouble() {
  const starts: unknown[] = []
  return {
    starts,
    startSession: (workspaceId?: unknown) => { starts.push(workspaceId ?? null) },
  }
}

/** A sessions double whose list can be moved and whose changes are pushed. */
function sessionsDouble(ctx: Context, state: {
  current?: string
  byId: Record<string, {
    id: string
    blank: boolean
    projectionValues?: { agentPreset?: string | null }
  }>
}) {
  const listeners = new Set<() => void>()
  const bindings = new Map<string, { sessionId: SessionId; ctx: Context }>()
  const snapshot = () => ({
    ...state,
    byId: Object.fromEntries(Object.entries(state.byId).map(([id, row]) => [
      id,
      {
        ...row,
        retainedBy: state.current === id ? { mainView: 1 } : {},
      },
    ])),
  })
  return {
    list: {
      getSnapshot: snapshot,
      subscribe: (fn: () => void) => {
        listeners.add(fn)
        return () => listeners.delete(fn)
      },
    },
    binding: (id: string) => {
      if (state.byId[id] === undefined) return undefined
      let binding = bindings.get(id)
      if (binding === undefined) {
        binding = { sessionId: SessionId(id), ctx }
        bindings.set(id, binding)
      }
      return binding
    },
    retainInfo: (id: string) => ({
      getSnapshot: () => {
        const retainedBy = snapshot().byId[id]?.retainedBy ?? {}
        return {
          referenceCount: Object.values(retainedBy).reduce((sum, count) => sum + count, 0),
          retainedBy,
        }
      },
      subscribe: (fn: () => void) => {
        listeners.add(fn)
        return () => listeners.delete(fn)
      },
    }),
    /** Push a list change the way the runtime's store does. */
    notify: () => { for (const fn of listeners) fn() },
    listenerCount: () => listeners.size,
  }
}

async function settingsWithoutChip(initialPreset: string, settingsRosterGate?: Promise<undefined>) {
  const b = await bench(settingsRosterGate === undefined ? {} : { settingsRosterGate })
  declareRoot(b.slots)
  const sessions = sessionsDouble(b.ctx, {
    current: 'blank',
    byId: { blank: { id: 'blank', blank: true, projectionValues: { agentPreset: initialPreset } } },
  })
  const bindingOwner = b.ctx.plugin({ apply() {} })
  await bindingOwner.await()
  sessions.binding('blank')!.ctx = bindingOwner.ctx
  b.ctx.provide('sessions', sessions as never)
  const feature = b.ctx.plugin({ inject: [...inject], apply })
  await feature.await()
  const section = (b.slots.entries('settings.section')[0]!
    .inject as unknown as () => AgentPresetSectionInjected)()
  await section.load()
  expect(b.slots.entries('conversation.hero.agentPreset')).toHaveLength(0)
  return { ...b, bindingOwner, feature, section, sessions }
}

describe('ui-agent-preset apply', () => {
  const settingsActions = [
    { action: 'makeDefault', initial: 'standard', selected: 'minimal', run: (section: AgentPresetSectionInjected) => section.makeDefault('minimal') },
  ]

  it.each(settingsActions)('synchronizes $action before the chip mounts', async ({ initial, selected, run }) => {
    const b = await settingsWithoutChip(initial)
    try {
      await run(b.section)
      expect(b.calls.filter(call => call.startsWith('select:'))).toEqual([`select:${selected}`])
      expect(b.sessions.listenerCount()).toBe(1)
    } finally {
      await b.ctx.fiber.dispose()
    }
    expect(b.sessions.listenerCount()).toBe(0)
  })

  it.each(settingsActions.flatMap(action => (['feature', 'binding'] as const).map(owner => ({ ...action, owner }))))(
    'does not finish $action into a disposed $owner before the chip mounts',
    async ({ initial, run, owner }) => {
      const saved = Promise.withResolvers<undefined>()
      const b = await settingsWithoutChip(initial, saved.promise)
      const operation = run(b.section)
      try {
        expect(b.sessions.listenerCount()).toBe(1)
        await b.settingsRosterStarted
        await (owner === 'feature' ? b.feature : b.bindingOwner).dispose()
        expect(b.sessions.listenerCount()).toBe(0)
        saved.resolve(undefined)
        await operation
        expect(b.calls.filter(call => call.startsWith('select:'))).toEqual([])
      } finally {
        saved.resolve(undefined)
        await operation
        await b.ctx.fiber.dispose()
      }
    },
  )

  it('keeps the host Loader entry inert', () => {
    expect(hostApply).not.toThrow()
  })

  it('declares the services it uses', () => {
    expect(inject).toEqual([
      'slots', 'sessions', 'locale', 'remote', 'remote.agentPresets', 'remote.settings', 'configForms',
    ])
  })

  it('registers the settings section and no General row', async () => {
    const { ctx, slots } = await bench()
    ctx.provide('sessions', sessionsDouble(ctx, { byId: {} }) as never)
    declareRoot(slots)

    await ctx.plugin({ inject: [...inject], apply }).await()

    // The default preset is edited in the section, where the roster is
    // visible; a General row would duplicate the same settings field.
    expect(slots.entries('settings.general.item')).toHaveLength(0)
    const section = slots.entries('settings.section')[0]!
    expect(section.component).toBe(AgentPresetSection)
    expect(section.options).toMatchObject({ id: 'agent-presets', order: 20 })
    // The nav label is a locale-following thunk; owners resolve it at read time.
    expect(resolveSlotLabel(section.options.label)).toBe('Agent 预设')
  })

  it('registers into a declaration that arrives after apply', async () => {
    const { ctx, slots } = await bench()
    ctx.provide('sessions', sessionsDouble(ctx, { byId: {} }) as never)
    await ctx.plugin({ inject: [...inject], apply }).await()

    declareRoot(slots)

    await vi.waitFor(() => { expect(slots.entries('settings.section')).toHaveLength(1) })
  })

  it('binds the Add plugin menu item to the roster and Creator flow and removes it with the feature', async () => {
    const { ctx, slots, setDeveloperTools } = await bench()
    try {
      slots.register({
        name: 'root',
        children: {
          'settings.section': { kind: 'list', scope: 'root' },
          conversation: { kind: 'single', scope: 'root' },
          'plugins.add.actions': { kind: 'list', scope: 'root' },
        },
      } as never, () => null)
      declareConversation(slots)
      ctx.provide('conversation', {} as never)
      ctx.provide('sessions', sessionsDouble(ctx, { byId: {} }) as never)
      const uiWorkspace = uiWorkspaceDouble()
      ctx.provide('uiWorkspace', uiWorkspace as never)
      const feature = ctx.plugin({ inject: [...inject, 'conversation', 'sessions', 'uiWorkspace'], apply })
      await feature.await()

      const entry = slots.entries('plugins.add.actions')[0]!
      expect(entry.component).toBe(CreatePluginMenuItem)
      const action: Partial<CreatePluginMenuItemInjected> | undefined = entry.inject?.()
      if (action?.load === undefined || action.hooks === undefined || action.startCreatorDraft === undefined) {
        throw new Error('expected the injected Create plugin actions')
      }
      await action.load()
      expect(action.hooks.agentPresets.getSnapshot().options).toEqual([{ id: 'standard' }])

      await setDeveloperTools(false)
      action.startCreatorDraft()
      expect(uiWorkspace.starts).toHaveLength(1)
      expect(ctx.configForms.developerTools.enabled.getSnapshot()).toBe(false)

      await feature.dispose()
      expect(slots.entries('plugins.add.actions')).toHaveLength(0)
      action.startCreatorDraft()
      expect(uiWorkspace.starts).toHaveLength(1)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('hands the section its own store, live Coding Tools preference, and default write', async () => {
    const { ctx, slots, setDeveloperTools } = await bench()
    ctx.provide('sessions', sessionsDouble(ctx, { byId: {} }) as never)
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()

    const section = (slots.entries('settings.section')[0]!.inject as unknown as () => AgentPresetSectionInjected)()

    expect(section.hooks.developerTools).toBe(ctx.configForms.developerTools.enabled)
    await setDeveloperTools(false)
    expect(section.hooks.developerTools.getSnapshot()).toBe(false)
    await section.load()
    await section.makeDefault('standard')
    expect(section.hooks.agentPresetSection.getSnapshot().rows)
      .toEqual([{ id: 'standard', isDefault: true }])
    await section.view('standard')
    expect(section.hooks.agentPresetSection.getSnapshot().view)
      .toEqual({ id: 'standard', title: 'standard', content: '# standard\n[]\n' })
    section.closeView()
    expect(section.hooks.agentPresetSection.getSnapshot().view).toBeNull()
  })

  it('refreshes a showing surface when its namespace changes, and ignores others', async () => {
    const { ctx, slots, calls, remote } = await bench()
    ctx.provide('sessions', sessionsDouble(ctx, { byId: {} }) as never)
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    const section = (slots.entries('settings.section')[0]!.inject as unknown as () => AgentPresetSectionInjected)()
    await section.load()
    const before = calls.length

    remote.emit('settings/document-updated', ['agent-preset-registry', 1])
    await vi.waitFor(() => { expect(calls.length).toBe(before + 3) })
    const afterRelevant = calls.length

    remote.emit('settings/document-updated', ['llm-deepseek', 1])
    await Promise.resolve()

    // The directory, section, and unbound seat re-read on their own namespace; an unrelated one moves
    // neither, so this rules out a blanket refresh on every settings write.
    expect(calls.length).toBe(afterRelevant)
  })

  it('re-reads both surfaces when the connection comes back', async () => {
    const { ctx, slots, calls } = await bench()
    declareRoot(slots)
    const conversation = declareConversation(slots)
    ctx.provide('conversation', {} as never)
    ctx.provide('sessions', sessionsDouble(ctx, { byId: {} }) as never)
    ctx.provide('uiWorkspace', uiWorkspaceDouble() as never)
    await ctx.plugin({ inject: [...inject], apply }).await()
    const section = (slots.entries('settings.section')[0]!.inject as unknown as () => AgentPresetSectionInjected)()
    await section.load()
    const before = calls.length

    ctx.emit('connection/reset')

    // A reconnect can land on a host whose roster changed under the browser.
    await vi.waitFor(() => { expect(calls.length).toBe(before + 3) })
    conversation()
  })

  it('leaves the section alone until it has been opened once', async () => {
    const { ctx, slots, calls, remote } = await bench()
    ctx.provide('sessions', sessionsDouble(ctx, { byId: {} }) as never)
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    const before = calls.length

    remote.emit('settings/document-updated', ['agent-preset-registry', 1])
    await vi.waitFor(() => { expect(calls.length).toBeGreaterThan(before) })

    // The directory and unbound seat reload: a section nobody opened has
    // nothing to converge, and reading the roster for it would be wasted.
    expect(calls.length - before).toBe(2)
  })

  it('registers the new-session chip and the header label, and drops both on disposal', async () => {
    const { ctx, slots } = await bench()
    declareRoot(slots)
    const conversation = declareConversation(slots)
    ctx.provide('conversation', {} as never)
    ctx.provide('sessions', sessionsDouble(ctx, { byId: {} }) as never)
    ctx.provide('uiWorkspace', uiWorkspaceDouble() as never)
    const fiber = ctx.plugin({ inject: [...inject, 'conversation', 'sessions', 'uiWorkspace'], apply })
    await fiber.await()

    const chip = slots.entries('conversation.hero.agentPreset')[0]!
    expect(chip.component).toBe(AgentPresetSeat)
    const label = slots.entries('conversation.session.header.actions')[0]!
    expect(label.component).toBe(AgentPresetLabel)
    expect(label.options).toMatchObject({ id: 'agent-preset', order: -10 })
    await fiber.dispose()
    expect(slots.entries('conversation.hero.agentPreset')).toHaveLength(0)
    expect(slots.entries('conversation.session.header.actions')).toHaveLength(0)
    expect(slots.entries('settings.section')).toHaveLength(0)
    conversation()
  })

  it('moves the chip when the default changes on the settings surface', async () => {
    const { ctx, slots, moveDefault, remote } = await bench()
    declareRoot(slots)
    const conversation = declareConversation(slots)
    ctx.provide('conversation', {} as never)
    ctx.provide('sessions', sessionsDouble(ctx, { byId: {} }) as never)
    ctx.provide('uiWorkspace', uiWorkspaceDouble() as never)
    await ctx.plugin({ inject: [...inject, 'conversation', 'sessions', 'uiWorkspace'], apply }).await()

    const chip = slots.entries('conversation.hero.agentPreset')[0]!
    const seat = (chip.inject as unknown as () => AgentPresetSeatInjected)()
    await seat.load()
    expect(seat.hooks.agentPresetSeat.getSnapshot().current).toBe('standard')

    // The chip opens on the deployment default, and the setting it comes from
    // lives on another screen: without this the next session — the very one
    // the setting governs — would be composed from the previous default until
    // a reload.
    // An unrelated namespace moves nothing: the chip re-reads on its own
    // setting, not on every settings write in the process.
    moveDefault()
    remote.emit('settings/document-updated', ['llm-deepseek', 1])
    await Promise.resolve()
    expect(seat.hooks.agentPresetSeat.getSnapshot().current).toBe('standard')

    remote.emit('settings/document-updated', ['agent-preset-registry', 1])
    await vi.waitFor(() => {
      expect(seat.hooks.agentPresetSeat.getSnapshot().current).toBe('minimal')
    })
    conversation()
  })

  it('keys bound seats by Provider generation and refreshes every live seat', async () => {
    const { ctx, slots, calls, remote } = await bench()
    declareRoot(slots)
    declareConversation(slots)
    ctx.provide('conversation', {} as never)
    const state: {
      current?: string
      byId: Record<string, {
        id: string
        blank: boolean
        projectionValues?: { agentPreset?: string | null }
      }>
    } = {
      current: 's1',
      byId: { s1: { id: 's1', blank: true, projectionValues: { agentPreset: 'standard' } } },
    }
    const sessions = sessionsDouble(ctx, state)
    ctx.provide('sessions', sessions as never)
    ctx.provide('uiWorkspace', uiWorkspaceDouble() as never)
    await ctx.plugin({ inject: [...inject, 'conversation', 'sessions', 'uiWorkspace'], apply }).await()
    const injectSeat = slots.entries('conversation.hero.agentPreset')[0]!
      .inject as unknown as (sessionId: SessionId) => AgentPresetSeatInjected
    const first = injectSeat(SessionId('s1'))
    const same = injectSeat(SessionId('s1'))
    expect(same.hooks.agentPresetSeat).toBe(first.hooks.agentPresetSeat)

    await first.load()
    const beforeRefresh = calls.length
    remote.emit('settings/document-updated', ['agent-preset-registry', 1])
    await vi.waitFor(() => { expect(calls.length).toBeGreaterThan(beforeRefresh + 2) })

    delete state.current
    sessions.notify()
    await first.load()
    state.byId = {}
    sessions.notify()
    await first.load()
    await ctx.fiber.dispose()
  })

  it.each(['feature', 'binding'] as const)('tracks bound preset changes until its %s owner stops', async (disposedOwner) => {
    const selection = Promise.withResolvers<undefined>()
    const { ctx, slots, calls } = await bench({ selectGate: selection.promise })
    try {
      declareRoot(slots)
      declareConversation(slots)
      ctx.provide('conversation', {} as never)
      const state = {
        current: 's1',
        byId: { s1: { id: 's1', blank: true, projectionValues: {} as { agentPreset?: string } } },
      }
      const sessions = sessionsDouble(ctx, state)
      const bindingOwner = ctx.plugin({ apply() {} })
      await bindingOwner.await()
      sessions.binding('s1')!.ctx = bindingOwner.ctx
      ctx.provide('sessions', sessions as never)
      ctx.provide('uiWorkspace', uiWorkspaceDouble() as never)
      const feature = ctx.plugin({ inject: [...inject, 'conversation', 'sessions', 'uiWorkspace'], apply })
      await feature.await()
      const seat = (slots.entries('conversation.hero.agentPreset')[0]!
        .inject as unknown as (sessionId: SessionId) => AgentPresetSeatInjected)(SessionId('s1'))
      await seat.load()
      expect(seat.hooks.agentPresetSeat.getSnapshot().current).toBe('')

      state.byId.s1.projectionValues.agentPreset = 'standard'
      sessions.notify()
      expect(seat.hooks.agentPresetSeat.getSnapshot().current).toBe('standard')
      state.byId.s1.projectionValues.agentPreset = 'minimal'
      sessions.notify()
      expect(seat.hooks.agentPresetSeat.getSnapshot().current).toBe('minimal')
      expect(calls.filter(call => call.startsWith('select:'))).toEqual([])

      const selecting = seat.select('standard')
      expect(seat.hooks.agentPresetSeat.getSnapshot().busy).toBe(true)
      sessions.notify()
      sessions.notify()
      expect(calls.filter(call => call.startsWith('select:'))).toEqual(['select:standard'])
      selection.resolve(undefined)
      await selecting
      state.byId.s1.projectionValues.agentPreset = 'standard'
      sessions.notify()

      await (disposedOwner === 'feature' ? feature : bindingOwner).dispose()
      state.byId.s1.projectionValues.agentPreset = 'minimal'
      sessions.notify()
      expect(seat.hooks.agentPresetSeat.getSnapshot().current).toBe('standard')
    } finally {
      selection.resolve(undefined)
      await ctx.fiber.dispose()
    }
  })

  it('uses Host selection events until reconnect refreshes the current binding', async () => {
    const b = await bench()
    declareRoot(b.slots)
    declareConversation(b.slots)
    b.ctx.provide('conversation', {} as never)
    const state = {
      current: 's1', byId: { s1: { id: 's1', blank: true, projectionValues: { agentPreset: 'standard' } } },
    }
    const sessions = sessionsDouble(b.ctx, state)
    b.ctx.provide('sessions', sessions as never)
    b.ctx.provide('uiWorkspace', uiWorkspaceDouble() as never)
    const feature = b.ctx.plugin({ inject: [...inject], apply })
    await feature.await()
    const injectSeat = b.slots.entries('conversation.hero.agentPreset')[0]!
      .inject as (id: SessionId) => AgentPresetSeatInjected & Record<string, unknown>
    const chip = injectSeat(SessionId('s1'))
    await chip.load()
    b.remote.emit('agent-preset/selected', [SessionId('unrelated'), 'minimal'])
    expect(chip.hooks.agentPresetSeat.getSnapshot().current).toBe('standard')
    b.remote.emit('agent-preset/selected', [SessionId('s1'), 'cordis'])
    sessions.notify()
    expect(chip.hooks.agentPresetSeat.getSnapshot().current).toBe('cordis')
    state.byId.s1.projectionValues.agentPreset = 'minimal'
    b.ctx.emit('connection/reset')
    await vi.waitFor(() => { expect(chip.hooks.agentPresetSeat.getSnapshot().current).toBe('minimal') })
    expect(b.calls.filter(call => call.startsWith('select:'))).toEqual([])
    await feature.dispose()
    b.remote.emit('agent-preset/selected', [SessionId('s1'), 'standard'])
    expect(chip.hooks.agentPresetSeat.getSnapshot().current).toBe('minimal')
    await b.ctx.fiber.dispose()
  })

  it('does not sync a blank Session that is not retained by the main view', async () => {
    const { ctx, slots, calls } = await bench()
    declareRoot(slots)
    declareConversation(slots)
    ctx.provide('conversation', {} as never)
    const sessions = sessionsDouble(ctx, {
      byId: { s1: { id: 's1', blank: true, projectionValues: { agentPreset: 'standard' } } },
    })
    ctx.provide('sessions', sessions as never)
    ctx.provide('uiWorkspace', uiWorkspaceDouble() as never)
    await ctx.plugin({ inject: [...inject, 'conversation', 'sessions', 'uiWorkspace'], apply }).await()
    const section = (slots.entries('settings.section')[0]!
      .inject as unknown as () => AgentPresetSectionInjected)()
    await section.load()

    await section.makeDefault('minimal')

    expect(calls).not.toContain('select:minimal')
  })

  it('aligns Settings defaults with the current blank Session, never a running one', async () => {
    const { ctx, slots, calls } = await bench()
    declareRoot(slots)
    const conversation = declareConversation(slots)
    ctx.provide('conversation', {} as never)
    const sessionState = {
      current: 's1',
      byId: {
        s1: { id: 's1', blank: true, projectionValues: { agentPreset: 'standard' } },
      },
    }
    const sessions = sessionsDouble(ctx, sessionState)
    ctx.provide('sessions', sessions as never)
    ctx.provide('uiWorkspace', uiWorkspaceDouble() as never)
    await ctx.plugin({ inject: [...inject, 'conversation', 'sessions', 'uiWorkspace'], apply }).await()
    const section = (slots.entries('settings.section')[0]!
      .inject as unknown as () => AgentPresetSectionInjected)()
    const seat = (slots.entries('conversation.hero.agentPreset')[0]!
      .inject as unknown as (sessionId: SessionId) => AgentPresetSeatInjected)(SessionId('s1'))
    await Promise.all([section.load(), seat.load()])

    await section.makeDefault('minimal')
    expect(calls.filter(call => call.startsWith('select:'))).toEqual(['select:minimal'])
    expect(seat.hooks.agentPresetSeat.getSnapshot().current).toBe('minimal')
    sessionState.byId.s1.projectionValues.agentPreset = 'minimal'

    expect(seat.hooks.agentPresetSeat.getSnapshot().current).toBe('minimal')

    sessionState.byId.s1.blank = false
    await section.makeDefault('standard')
    expect(calls.filter(call => call.startsWith('select:'))).toEqual(['select:minimal'])
    conversation()
  })

  it('reloads Host truth after a default save failure', async () => {
    const { ctx, slots, calls } = await bench({ failSettingsUpdate: true })
    ctx.provide('sessions', sessionsDouble(ctx, { byId: {} }) as never)
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    const section = (slots.entries('settings.section')[0]!
      .inject as unknown as () => AgentPresetSectionInjected)()
    await section.load()
    expect(section.hooks.agentPresetSection.getSnapshot().rows)
      .toEqual([{ id: 'standard', isDefault: true }])

    await section.makeDefault('minimal')

    expect(calls.filter(call => call === 'list')).toHaveLength(2)
    expect(section.hooks.agentPresetSection.getSnapshot()).toMatchObject({
      saving: false, error: 'settings write disconnected',
    })
  })

  it('applies the staged choice to the blank session the flow lands on', async () => {
    const { ctx, slots, calls } = await bench()
    declareRoot(slots)
    declareConversation(slots)
    ctx.provide('conversation', {} as never)
    const state: {
      current?: string
      byId: Record<string, {
        id: string
        blank: boolean
        projectionValues?: { agentPreset?: string | null }
      }>
    } = { byId: {} }
    const sessions = sessionsDouble(ctx, state)
    ctx.provide('sessions', sessions as never)
    ctx.provide('uiWorkspace', uiWorkspaceDouble() as never)
    await ctx.plugin({ inject: [...inject, 'conversation', 'sessions', 'uiWorkspace'], apply }).await()
    const injectSeat = slots.entries('conversation.hero.agentPreset')[0]!
      .inject as unknown as (sessionId?: SessionId) => AgentPresetSeatInjected
    const chip = injectSeat()

    await chip.load()
    // Picked on the hero screen, where there is no session yet.
    await chip.select('minimal')
    expect(calls).not.toContain('select:minimal')

    state.current = 's1'
    state.byId['s1'] = {
      id: 's1', blank: true, projectionValues: { agentPreset: 'standard' },
    }
    sessions.notify()
    const bound = injectSeat(SessionId('s1'))
    await bound.load()

    // Connecting a workspace produced the session; the stage reaches it there.
    await vi.waitFor(() => { expect(calls).toContain('select:minimal') })
  })

  it('applies the stage to a session that records no preset of its own', async () => {
    const { ctx, slots, calls } = await bench()
    declareRoot(slots)
    declareConversation(slots)
    ctx.provide('conversation', {} as never)
    const sessions = sessionsDouble(ctx, {
      current: 's1',
      byId: { s1: { id: 's1', blank: true } },
    })
    ctx.provide('sessions', sessions as never)
    ctx.provide('uiWorkspace', uiWorkspaceDouble() as never)
    await ctx.plugin({ inject: [...inject, 'conversation', 'sessions', 'uiWorkspace'], apply }).await()
    const chip = (slots.entries('conversation.hero.agentPreset')[0]!
      .inject as unknown as (sessionId: SessionId) => AgentPresetSeatInjected)(SessionId('s1'))

    await chip.load()
    await chip.select('minimal')

    // A session created before the deployment composed presets records none;
    // reading that as "already runs it" would drop the pick on the floor.
    expect(calls).toContain('select:minimal')
  })

  it('forgets the stage once it has been spent', async () => {
    const { ctx, slots, calls } = await bench()
    declareRoot(slots)
    declareConversation(slots)
    ctx.provide('conversation', {} as never)
    const state = {
      current: 's1',
      byId: {
        s1: { id: 's1', blank: true, projectionValues: { agentPreset: 'standard' } },
      },
    }
    const sessions = sessionsDouble(ctx, state)
    ctx.provide('sessions', sessions as never)
    ctx.provide('uiWorkspace', uiWorkspaceDouble() as never)
    await ctx.plugin({ inject: [...inject, 'conversation', 'sessions', 'uiWorkspace'], apply }).await()
    const chip = (slots.entries('conversation.hero.agentPreset')[0]!
      .inject as unknown as (sessionId: SessionId) => AgentPresetSeatInjected)(SessionId('s1'))

    await chip.load()
    await chip.select('minimal')
    const spent = calls.filter(call => call === 'select:minimal').length
    sessions.notify()
    sessions.notify()

    // Every later list movement would re-apply a stage that was not cleared,
    // switching sessions the user never picked for.
    await Promise.resolve()
    expect(calls.filter(call => call === 'select:minimal')).toHaveLength(spent)
  })

  it.each(['standard', 'cordis', 'mine'])('preserves the allowed staged %s choice when Developer tools turn off', async (preset) => {
    const { ctx, slots, calls, setDeveloperTools } = await bench()
    declareRoot(slots)
    declareConversation(slots)
    ctx.provide('conversation', {} as never)
    const state: {
      current?: string
      byId: Record<string, { id: string; blank: boolean; projectionValues?: { agentPreset?: string | null } }>
    } = {
      byId: { s1: { id: 's1', blank: true, projectionValues: { agentPreset: 'ptc' } } },
    }
    const sessions = sessionsDouble(ctx, state)
    ctx.provide('sessions', sessions as never)
    ctx.provide('uiWorkspace', uiWorkspaceDouble() as never)
    await ctx.plugin({ inject: [...inject, 'conversation', 'sessions', 'uiWorkspace'], apply }).await()
    const injectSeat = slots.entries('conversation.hero.agentPreset')[0]!
      .inject as (sessionId?: SessionId) => AgentPresetSeatInjected & Record<string, unknown>
    const chip = injectSeat(SessionId('s1'))
    await chip.load()
    await chip.select(preset)
    await setDeveloperTools(false)
    await chip.load()
    expect(chip.hooks.agentPresetSeat.getSnapshot().current).toBe(preset)
    expect(calls.filter(call => call.startsWith('select:'))).toEqual([])

    state.current = 's1'
    sessions.notify()
    await vi.waitFor(() => {
      expect(calls.filter(call => call.startsWith('select:'))).toEqual([`select:${preset}`])
    })
  })

  it('does not reset a default during bootstrap or after accepting Coding Tools on', async () => {
    const described = Promise.withResolvers<undefined>()
    const b = await bench({ describeGate: described.promise, presets: ROSTER_MOVED.value.presets })
    b.ctx.provide('sessions', sessionsDouble(b.ctx, { byId: {} }) as never)
    declareRoot(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    expect(b.ctx.configForms.developerTools.enabled.getSnapshot()).toBe(false)
    await Promise.resolve()
    expect(b.calls.filter(call => call.startsWith('settings:'))).toEqual([])
    described.resolve(undefined)
    await vi.waitFor(() => { expect(b.ctx.configForms.developerTools.enabled.getSnapshot()).toBe(true) })
    expect(b.calls.filter(call => call.startsWith('settings:'))).toEqual([])
    await b.ctx.fiber.dispose()
  })

  it.each(['ptc', 'minimal'])('resets an accepted disabled %s default once, without restoring it on enable', async (id) => {
    const b = await bench({ developerToolsEnabled: false, presets: [
      { id: 'standard', isDefault: false }, { id, isDefault: true },
    ] })
    b.ctx.provide('sessions', sessionsDouble(b.ctx, { byId: {} }) as never)
    declareRoot(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    await vi.waitFor(() => { expect(b.calls.filter(call => call.startsWith('settings:'))).toEqual(['settings:{"selectedDefault":"standard"}']) })
    const section = (b.slots.entries('settings.section')[0]!.inject as () => AgentPresetSectionInjected & Record<string, unknown>)()
    await vi.waitFor(() => { expect(section.hooks.agentPresetSection.getSnapshot().rows.find(row => row.isDefault)?.id).toBe('standard') })
    await b.setDeveloperTools(true)
    expect(b.calls.filter(call => call.startsWith('settings:'))).toEqual(['settings:{"selectedDefault":"standard"}'])
    expect(section.hooks.agentPresetSection.getSnapshot().rows.find(row => row.isDefault)?.id).toBe('standard')
    await b.ctx.fiber.dispose()
  })

  it.each([['standard', undefined], ['cordis', undefined], ['mine', 'Mine'], ['ptc', 'Custom PTC'], ['minimal', 'Custom Minimal']] as const)(
    'keeps the allowed default %s (%s) when Coding Tools are disabled', async (id, name) => {
      const b = await bench({ developerToolsEnabled: false, presets: [
        { id, isDefault: true, ...(name === undefined ? {} : { name }) },
        ...(id === 'standard' ? [] : [{ id: 'standard', isDefault: false }]),
      ] })
      b.ctx.provide('sessions', sessionsDouble(b.ctx, { byId: {} }) as never)
      declareRoot(b.slots)
      await b.ctx.plugin({ inject: [...inject], apply }).await()
      const section = (b.slots.entries('settings.section')[0]!.inject as () => AgentPresetSectionInjected & Record<string, unknown>)()
      await section.load()
      await Promise.resolve()
      expect(b.calls.filter(call => call.startsWith('settings:'))).toEqual([])
      expect(section.hooks.agentPresetSection.getSnapshot().rows.find(row => row.isDefault)?.id).toBe(id)
      await b.ctx.fiber.dispose()
    },
  )

  it('resets an existing hidden default when the accepted preference turns off', async () => {
    const b = await bench({ presets: ROSTER_MOVED.value.presets })
    b.ctx.provide('sessions', sessionsDouble(b.ctx, { byId: {} }) as never)
    declareRoot(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    expect(b.calls.filter(call => call.startsWith('settings:'))).toEqual([])
    await b.setDeveloperTools(false)
    expect(b.ctx.configForms.get('agent-preset-registry').getSnapshot()).toMatchObject({ status: 'ready', mode: 'host', writable: true, revision: 0 })
    await vi.waitFor(() => { expect(b.calls.filter(call => call.startsWith('settings:'))).toEqual(['settings:{"selectedDefault":"standard"}']) })
    await b.ctx.fiber.dispose()
  })

  it.each(['cordis', 'mine'])('resets only the hidden default while the current blank task already uses %s', async (preset) => {
    const b = await bench({ presets: [
      { id: 'standard', isDefault: false }, { id: 'minimal', isDefault: true },
      { id: 'cordis', isDefault: false }, { id: 'mine', name: 'Mine', isDefault: false },
    ] })
    declareRoot(b.slots)
    declareConversation(b.slots)
    b.ctx.provide('conversation', {} as never)
    b.ctx.provide('sessions', sessionsDouble(b.ctx, {
      current: 'blank', byId: { blank: { id: 'blank', blank: true, projectionValues: { agentPreset: preset } } },
    }) as never)
    b.ctx.provide('uiWorkspace', uiWorkspaceDouble() as never)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const chip = (b.slots.entries('conversation.hero.agentPreset')[0]!.inject as (id: SessionId) => AgentPresetSeatInjected & Record<string, unknown>)(SessionId('blank'))
    await chip.load()
    expect(chip.hooks.agentPresetSeat.getSnapshot().current).toBe(preset)
    await b.setDeveloperTools(false)
    await vi.waitFor(() => { expect(b.calls.filter(call => call.startsWith('settings:'))).toEqual(['settings:{"selectedDefault":"standard"}']) })
    await chip.load()
    expect(b.calls.filter(call => call.startsWith('select:'))).toEqual([])
    expect(chip.hooks.agentPresetSeat.getSnapshot().current).toBe(preset)
    await b.ctx.fiber.dispose()
  })

  it('does not correct a default when settings first arrive after the feature is disposed', async () => {
    const described = Promise.withResolvers<undefined>()
    const b = await bench({ describeGate: described.promise, developerToolsEnabled: false, presets: ROSTER_MOVED.value.presets })
    b.ctx.provide('sessions', sessionsDouble(b.ctx, { byId: {} }) as never)
    declareRoot(b.slots)
    const feature = b.ctx.plugin({ inject: [...inject], apply })
    await feature.await()
    await feature.dispose()
    described.resolve(undefined)
    await vi.waitFor(() => { expect(b.ctx.configForms.get('ui-settings').getSnapshot().status).toBe('ready') })
    expect(b.calls.filter(call => call.startsWith('settings:'))).toEqual([])
    expect(b.calls.filter(call => call.startsWith('select:'))).toEqual([])
    await b.ctx.fiber.dispose()
  })

  it('does not switch a blank task after disposal interrupts an automatic default correction', async () => {
    const refreshed = Promise.withResolvers<undefined>()
    const b = await bench({
      developerToolsEnabled: false, presets: ROSTER_MOVED.value.presets, settingsRosterGate: refreshed.promise,
    })
    declareRoot(b.slots)
    declareConversation(b.slots)
    b.ctx.provide('conversation', {} as never)
    const sessions = sessionsDouble(b.ctx, {
      current: 'blank', byId: { blank: { id: 'blank', blank: true, projectionValues: { agentPreset: 'minimal' } } },
    })
    b.ctx.provide('sessions', sessions as never)
    b.ctx.provide('uiWorkspace', uiWorkspaceDouble() as never)
    const feature = b.ctx.plugin({ inject: [...inject], apply })
    await feature.await()
    try {
      await b.settingsRosterStarted
      expect(b.calls.filter(call => call.startsWith('settings:'))).toEqual(['settings:{"selectedDefault":"standard"}'])
      const stopping = feature.dispose()
      refreshed.resolve(undefined)
      await stopping
      expect(b.calls.filter(call => call.startsWith('select:'))).toEqual([])
      expect(b.calls.filter(call => call.startsWith('settings:'))).toHaveLength(1)
      expect(sessions.listenerCount()).toBe(0)
    } finally {
      refreshed.resolve(undefined)
      await b.ctx.fiber.dispose()
    }
  })

  it('exposes a refused correction without repeatedly writing the same default', async () => {
    const b = await bench({ failSettingsUpdate: true, presets: ROSTER_MOVED.value.presets })
    b.ctx.provide('sessions', sessionsDouble(b.ctx, { byId: {} }) as never)
    declareRoot(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const section = (b.slots.entries('settings.section')[0]!.inject as () => AgentPresetSectionInjected & Record<string, unknown>)()
    await b.setDeveloperTools(false)
    await vi.waitFor(() => { expect(section.hooks.agentPresetSection.getSnapshot().error).toBe('settings write disconnected') })
    expect(b.calls.filter(call => call.startsWith('settings:'))).toEqual(['settings:{"selectedDefault":"standard"}'])
    expect(section.hooks.agentPresetSection.getSnapshot().rows.find(row => row.isDefault)?.id).toBe('minimal')
    await b.ctx.fiber.dispose()
  })

  it('keeps a browser-local Coding Tools choice from rewriting the Host default', async () => {
    const b = await bench({ memory: true, presets: ROSTER_MOVED.value.presets })
    b.ctx.provide('sessions', sessionsDouble(b.ctx, { byId: {} }) as never)
    declareRoot(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    await b.ctx.configForms.developerTools.setEnabled(false)
    const section = (b.slots.entries('settings.section')[0]!.inject as () => AgentPresetSectionInjected & Record<string, unknown>)()
    await section.load()
    expect(section.hooks.agentPresetSection.getSnapshot().rows.find(row => row.isDefault)?.id).toBe('minimal')
    expect(b.calls.filter(call => call.startsWith('settings:'))).toEqual([])
    await b.ctx.fiber.dispose()
  })

  it('loads the header label from the shared roster store', async () => {
    const { ctx, slots } = await bench()
    declareRoot(slots)
    declareConversation(slots)
    ctx.provide('conversation', {} as never)
    ctx.provide('sessions', sessionsDouble(ctx, { byId: {} }) as never)
    ctx.provide('uiWorkspace', uiWorkspaceDouble() as never)
    await ctx.plugin({ inject: [...inject, 'conversation', 'sessions', 'uiWorkspace'], apply }).await()
    const label = (slots.entries('conversation.session.header.actions')[0]!
      .inject as unknown as () => AgentPresetLabelInjected)()

    await label.load()

    expect(label.hooks.agentPresets.getSnapshot().options).toEqual([{ id: 'standard' }])
  })

  it('stages the creator preset and starts a session from the section', async () => {
    const { ctx, slots } = await bench()
    declareRoot(slots)
    const conversation = declareConversation(slots)
    ctx.provide('conversation', {} as never)
    ctx.provide('sessions', sessionsDouble(ctx, { byId: {} }) as never)
    const uiWorkspace = uiWorkspaceDouble()
    ctx.provide('uiWorkspace', uiWorkspace as never)
    await ctx.plugin({ inject: [...inject, 'conversation', 'sessions', 'uiWorkspace'], apply }).await()
    const section = (slots.entries('settings.section')[0]!.inject as unknown as () => AgentPresetSectionInjected)()
    const injectSeat = slots.entries('conversation.hero.agentPreset')[0]!
      .inject as unknown as (sessionId?: SessionId) => AgentPresetSeatInjected
    const seat = injectSeat()

    await section.load()
    section.startCreatorDraft?.()

    // The pick is staged on the chip's own controller — the session the
    // workspace start produces is what the stage lands on — and exactly one
    // new-session flow began.
    expect(section.startCreatorDraft).toBeDefined()
    expect(seat.hooks.agentPresetSeat.getSnapshot().current).toBe('cordis')
    expect(uiWorkspace.starts).toHaveLength(1)

    // A cross-screen stage carries the introduce cue; the chip acknowledges
    // it once, and a repeat acknowledgement leaves the snapshot untouched.
    expect(seat.hooks.agentPresetSeat.getSnapshot().introduce).toBe(true)
    seat.introduced()
    const acknowledged = seat.hooks.agentPresetSeat.getSnapshot()
    expect(acknowledged.introduce).toBe(false)
    seat.introduced()
    expect(seat.hooks.agentPresetSeat.getSnapshot()).toBe(acknowledged)
    conversation()
  })

  it('applies the creator preset to an existing blank main Session', async () => {
    const { ctx, slots, calls } = await bench()
    declareRoot(slots)
    const conversation = declareConversation(slots)
    ctx.provide('conversation', {} as never)
    const sessions = sessionsDouble(ctx, {
      current: 's1',
      byId: { s1: { id: 's1', blank: true, projectionValues: { agentPreset: 'standard' } } },
    })
    ctx.provide('sessions', sessions as never)
    const uiWorkspace = uiWorkspaceDouble()
    ctx.provide('uiWorkspace', uiWorkspace as never)
    await ctx.plugin({ inject: [...inject, 'conversation', 'sessions', 'uiWorkspace'], apply }).await()
    const section = (slots.entries('settings.section')[0]!.inject as unknown as () => AgentPresetSectionInjected)()
    const injectSeat = slots.entries('conversation.hero.agentPreset')[0]!
      .inject as unknown as (sessionId?: SessionId) => AgentPresetSeatInjected
    const seat = injectSeat(SessionId('s1'))

    await seat.load()
    await section.load()
    section.startCreatorDraft?.()

    await vi.waitFor(() => { expect(calls).toContain('select:cordis') })
    expect(seat.hooks.agentPresetSeat.getSnapshot().current).toBe('cordis')
    expect(uiWorkspace.starts).toHaveLength(1)
    conversation()
  })

  it('keeps the applied composition when the roster load lands late', async () => {
    const { ctx, slots, calls } = await bench()
    declareRoot(slots)
    const conversation = declareConversation(slots)
    ctx.provide('conversation', {} as never)
    const state: {
      current?: string
      byId: Record<string, {
        id: string
        blank: boolean
        projectionValues?: { agentPreset?: string | null }
      }>
    } = { byId: {} }
    const sessions = sessionsDouble(ctx, state)
    ctx.provide('sessions', sessions as never)
    ctx.provide('uiWorkspace', uiWorkspaceDouble() as never)
    await ctx.plugin({ inject: [...inject, 'conversation', 'sessions', 'uiWorkspace'], apply }).await()
    const section = (slots.entries('settings.section')[0]!.inject as unknown as () => AgentPresetSectionInjected)()
    const injectSeat = slots.entries('conversation.hero.agentPreset')[0]!
      .inject as unknown as (sessionId?: SessionId) => AgentPresetSeatInjected

    await section.load()
    section.startCreatorDraft?.()
    state.current = 's1'
    state.byId['s1'] = { id: 's1', blank: true }
    sessions.notify()
    const boundSeat = injectSeat(SessionId('s1'))
    await boundSeat.load()
    await vi.waitFor(() => { expect(calls).toContain('select:cordis') })

    // The chip mounts with the flow's session, so its roster load can land
    // AFTER the stage was consumed; the session's own composition is what
    // the display must keep — not the deployment default.
    state.byId['s1'] = {
      id: 's1', blank: true, projectionValues: { agentPreset: 'cordis' },
    }
    await boundSeat.load()

    expect(boundSeat.hooks.agentPresetSeat.getSnapshot().current).toBe('cordis')
    conversation()
  })

  it('offers no creator draft while the conversation flow is absent', async () => {
    const { ctx, slots } = await bench()
    ctx.provide('sessions', sessionsDouble(ctx, { byId: {} }) as never)
    declareRoot(slots)

    await ctx.plugin({ inject: [...inject], apply }).await()

    // No conversation scope mounted: the face omits the affordance and the
    // section hides its button rather than staging into nowhere.
    const section = (slots.entries('settings.section')[0]!.inject as unknown as () => AgentPresetSectionInjected)()
    expect(section.startCreatorDraft).toBeUndefined()
  })
})

describe('AgentPresetSeatController reconciliation', () => {
  it('keeps a repeated-ID selection chain while its ordered owner events arrive after the RPC replies', async () => {
    const select = vi.fn((_id: SessionId, id: string) => Promise.resolve({ ok: true as const, value: id }))
    let disabled = false
    let session = { id: SessionId('blank'), blank: true, projectionValues: { agentPreset: 'standard' } }
    const controller = new AgentPresetSeatController({ remote: { agentPresets: {
      select,
      list: () => Promise.resolve({ ok: true, value: { presets: [
        { id: 'standard', isDefault: true }, { id: 'minimal', isDefault: false },
        { id: 'cordis', isDefault: false }, { id: 'mine', isDefault: false },
      ] } }),
    } } } as never, () => session, undefined, () => disabled)
    await controller.load()
    for (const preset of ['minimal', 'standard', 'cordis']) await controller.select(preset)
    disabled = true
    await controller.reconcileCodingTools()
    for (const preset of ['minimal', 'standard', 'cordis']) {
      session = { ...session, projectionValues: { agentPreset: preset } }
      controller.observeSelection(session.id, preset)
      await controller.reconcileCodingTools()
      expect(controller.store.getSnapshot().current).toBe('cordis')
    }
    expect(select.mock.calls.map(call => call[1])).toEqual(['minimal', 'standard', 'cordis'])
    controller.observeSelection(session.id, 'mine')
    await controller.reconcileCodingTools()
    expect(controller.store.getSnapshot().current).toBe('mine')
    controller.resetSelection()
    await controller.load()
    expect(controller.store.getSnapshot().current).toBe('cordis')
  })

  it.each(['external', 'reset'] as const)('does not overwrite a newer %s observation with an older RPC reply', async (change) => {
    const reply = Promise.withResolvers<{ ok: true; value: string }>()
    const select = vi.fn(() => reply.promise)
    const session = {
      id: SessionId('blank'), blank: true,
      ...change === 'reset' ? {} : { projectionValues: { agentPreset: 'standard' } },
    }
    const controller = new AgentPresetSeatController({ remote: { agentPresets: { select } } } as never, () => session)
    const pending = controller.select('minimal')
    if (change === 'external') {
      controller.observeSelection(session.id, 'minimal')
      controller.observeSelection(session.id, 'mine')
    } else controller.resetSelection()
    reply.resolve({ ok: true, value: 'minimal' })
    await pending
    expect(controller.store.getSnapshot().current).toBe(change === 'external' ? 'mine' : '')
  })

  it.each(['before', 'after'] as const)('preserves a newer Creator choice when the Minimal projection arrives %s its response', async (timing) => {
    const creatorReply = Promise.withResolvers<{ ok: true; value: string }>()
    const select = vi.fn((_id: SessionId, id: string) => id === 'cordis'
      ? creatorReply.promise
      : Promise.resolve({ ok: true as const, value: id }))
    let disabled = false
    let session = { id: SessionId('blank'), blank: true, projectionValues: { agentPreset: 'standard' } }
    const controller = new AgentPresetSeatController({ remote: { agentPresets: {
      select,
      list: () => Promise.resolve({ ok: true, value: { presets: [
        { id: 'standard', isDefault: true }, { id: 'minimal', isDefault: false },
        { id: 'cordis', isDefault: false }, { id: 'mine', isDefault: false },
      ] } }),
    } } } as never, () => session, undefined, () => disabled)
    await controller.load()
    await controller.select('minimal')
    controller.observeSelection(session.id, 'minimal')
    const creator = controller.select('cordis')
    if (timing === 'before') session = { ...session, projectionValues: { agentPreset: 'minimal' } }
    creatorReply.resolve({ ok: true, value: 'cordis' })
    await creator
    controller.observeSelection(session.id, 'cordis')
    if (timing === 'after') session = { ...session, projectionValues: { agentPreset: 'minimal' } }
    disabled = true
    await controller.reconcileCodingTools()
    expect(select.mock.calls.map(call => call[1])).toEqual(['minimal', 'cordis'])
    expect(controller.store.getSnapshot().current).toBe('cordis')

    // Later Host owner events stand even while the projection catches up.
    session = { ...session, projectionValues: { agentPreset: 'cordis' } }
    await controller.apply()
    session = { ...session, projectionValues: { agentPreset: 'minimal' } }
    controller.observeSelection(session.id, 'minimal')
    await controller.apply()
    expect(select.mock.calls.map(call => call[1])).toEqual(['minimal', 'cordis', 'standard'])

    // An unrelated external preset also supersedes an unconfirmed RPC receipt.
    session = { ...session, projectionValues: { agentPreset: 'mine' } }
    controller.observeSelection(session.id, 'mine')
    await controller.apply()
    expect(controller.store.getSnapshot().current).toBe('mine')
  })

  it.each(['minimal', 'ptc', 'cordis'])('rechecks an in-flight %s selection after Coding Tools turn off', async (preset) => {
    const firstReply = Promise.withResolvers<{ ok: true; value: string }>()
    let calls = 0
    const select = vi.fn((_id: SessionId, id: string) => ++calls === 1
      ? firstReply.promise
      : Promise.resolve({ ok: true as const, value: id }))
    let disabled = false
    const controller = new AgentPresetSeatController({ remote: { agentPresets: {
      select,
      list: () => Promise.resolve({ ok: true, value: { presets: [
        { id: 'standard', isDefault: true }, { id: preset, isDefault: false },
      ] } }),
    } } } as never, () => ({
      id: SessionId('blank'), blank: true, projectionValues: { agentPreset: 'standard' },
    }), undefined, () => disabled)
    await controller.load()
    const first = controller.select(preset)
    disabled = true
    const reconcile = controller.reconcileCodingTools()
    controller.observeSelection(SessionId('blank'), preset)
    firstReply.resolve({ ok: true, value: preset })
    await Promise.all([first, reconcile])
    await controller.apply()
    expect(select.mock.calls.map(call => call[1])).toEqual(preset === 'cordis' ? [preset] : [preset, 'standard'])
    expect(controller.store.getSnapshot().current).toBe(preset === 'cordis' ? preset : 'standard')
  })

  it.each(['enabled', 'replaced', 'left', 'started', 'creator'] as const)(
    'rechecks %s while a Coding Tools correction waits for an earlier selection', async (change) => {
      const firstReply = Promise.withResolvers<{ ok: true; value: string }>()
      let calls = 0
      const select = vi.fn((_id: SessionId, id: string) => ++calls === 1
        ? firstReply.promise
        : Promise.resolve({ ok: true as const, value: id }))
      let disabled = false
      let session: { id: SessionId; blank: boolean; projectionValues: { agentPreset: string } } | undefined = {
        id: SessionId('blank'), blank: true, projectionValues: { agentPreset: 'standard' },
      }
      const controller = new AgentPresetSeatController({ remote: { agentPresets: {
        select,
        list: () => Promise.resolve({ ok: true, value: { presets: [
          { id: 'standard', isDefault: true }, { id: 'minimal', isDefault: false }, { id: 'cordis', isDefault: false },
        ] } }),
      } } } as never, () => session, undefined, () => disabled)
      await controller.load()
      const first = controller.select('minimal')
      disabled = true
      const reconcile = controller.reconcileCodingTools()
      if (change === 'enabled') disabled = false
      else if (change === 'left') session = undefined
      else if (change === 'replaced') session = { ...session, id: SessionId('replacement') }
      else if (change === 'started') session.blank = false
      else controller.stage('cordis', true)
      controller.observeSelection(SessionId('blank'), 'minimal')
      firstReply.resolve({ ok: true, value: 'minimal' })
      await Promise.all([first, reconcile])
      expect(select.mock.calls.map(call => call[1])).toEqual(change === 'creator' ? ['minimal', 'cordis'] : ['minimal'])
      if (change === 'creator') expect(controller.store.getSnapshot().current).toBe('cordis')
    },
  )

  it.each([new Error('Disconnected'), 'Disconnected'])('reports a transport failure once when an automatic Standard selection cannot finish: %s', async (failure) => {
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- Non-Error transport rejection is the scenario under test.
    const select = vi.fn(() => Promise.reject(failure))
    const controller = new AgentPresetSeatController({ remote: { agentPresets: {
      select,
      list: () => Promise.resolve({ ok: true, value: { presets: [
        { id: 'standard', isDefault: true }, { id: 'minimal', isDefault: false },
      ] } }),
    } } } as never, () => ({
      id: SessionId('blank'), blank: true, projectionValues: { agentPreset: 'minimal' },
    }), undefined, () => true)
    await controller.load()
    await controller.apply()
    await controller.load()
    expect(select).toHaveBeenCalledOnce()
    expect(controller.store.getSnapshot()).toMatchObject({ current: 'minimal', error: 'Disconnected', busy: false })
  })

  it('keeps an uncomposed blank Session honest after its staged fallback disconnects', async () => {
    const select = vi.fn(() => Promise.reject(new Error('Disconnected')))
    let disabled = false
    const controller = new AgentPresetSeatController({ remote: { agentPresets: {
      select,
      list: () => Promise.resolve({ ok: true, value: { presets: [
        { id: 'standard', isDefault: true }, { id: 'minimal', isDefault: false },
      ] } }),
    } } } as never, () => ({ id: SessionId('blank'), blank: true }), undefined, () => disabled)
    await controller.load()
    controller.stage('minimal')
    disabled = true
    await controller.reconcileCodingTools()
    expect(select).toHaveBeenCalledExactlyOnceWith(SessionId('blank'), 'standard')
    expect(controller.store.getSnapshot()).toMatchObject({ current: '', error: 'Disconnected', busy: false })
  })

  it('propagates an explicit selection transport failure and releases it before an automatic fallback', async () => {
    const failure = new Error('Disconnected')
    const select = vi.fn((_id: SessionId, id: string) => Promise.resolve({ ok: true as const, value: id }))
      .mockRejectedValueOnce(failure)
    let disabled = false
    const controller = new AgentPresetSeatController({ remote: { agentPresets: {
      select,
      list: () => Promise.resolve({ ok: true, value: { presets: [
        { id: 'standard', isDefault: true }, { id: 'minimal', isDefault: false }, { id: 'cordis', isDefault: false },
      ] } }),
    } } } as never, () => ({
      id: SessionId('blank'), blank: true, projectionValues: { agentPreset: 'minimal' },
    }), undefined, () => disabled)
    await controller.load()
    await expect(controller.select('cordis')).rejects.toBe(failure)
    expect(controller.store.getSnapshot().busy).toBe(false)
    disabled = true
    await controller.reconcileCodingTools()
    expect(select.mock.calls.map(call => call[1])).toEqual(['cordis', 'standard'])
    expect(controller.store.getSnapshot()).toMatchObject({ current: 'standard', error: null, busy: false })
  })

  it.each([
    { refuseFirst: false, refuseLatest: false },
    { refuseFirst: false, refuseLatest: true },
    { refuseFirst: true, refuseLatest: false },
    { refuseFirst: true, refuseLatest: true },
  ])('waits for a newer Settings selection (first refused: $refuseFirst, latest refused: $refuseLatest)', async ({ refuseFirst, refuseLatest }) => {
    const refusal = { ok: false as const, error: new RemoteError('gateway/internal', 'selection refused', {}) }
    type Outcome = { ok: true; value: string } | typeof refusal
    const requests: { preset: string; outcome: ReturnType<typeof Promise.withResolvers<Outcome>> }[] = []
    const session = { id: SessionId('blank'), blank: true, projectionValues: { agentPreset: 'standard' } }
    const controller = new AgentPresetSeatController({
      ...developerTools(),
      remote: { agentPresets: { select: (_id: SessionId, preset: string) => {
        const outcome = Promise.withResolvers<Outcome>()
        requests.push({ preset, outcome })
        return outcome.promise
      } } },
    } as never, () => session)
    const first = controller.select('minimal')
    let settingsSettled = false
    const settings = controller.syncBlankSession(session.id, 'cordis').finally(() => { settingsSettled = true })
    await controller.apply()
    expect(requests.map(request => request.preset)).toEqual(['minimal'])
    requests[0]!.outcome.resolve(refuseFirst ? refusal : { ok: true, value: 'minimal' })
    await first
    expect(requests.map(request => request.preset)).toEqual(['minimal', 'cordis'])
    expect(settingsSettled).toBe(false)
    await controller.apply()
    expect(requests).toHaveLength(2)
    requests[1]!.outcome.resolve(refuseLatest ? refusal : { ok: true, value: 'cordis' })
    await expect(settings).resolves.toBe(refuseLatest ? 'selection refused' : undefined)
    expect(controller.store.getSnapshot()).toMatchObject({
      current: refuseLatest ? (refuseFirst ? 'standard' : 'minimal') : 'cordis', busy: false,
      error: refuseLatest ? 'selection refused' : null,
    })
  })

  it.each([false, true])('preserves a stage created while an earlier selection is pending (refused: %s)', async (refused) => {
    const refusal = { ok: false as const, error: new RemoteError('gateway/internal', 'selection refused', {}) }
    const firstReply = Promise.withResolvers<{ ok: true; value: string } | typeof refusal>()
    const select = vi.fn((_id: SessionId, preset: string) => preset === 'minimal'
      ? firstReply.promise
      : Promise.resolve({ ok: true as const, value: preset }))
    const controller = new AgentPresetSeatController({ ...developerTools(), remote: { agentPresets: { select } } } as never,
      () => ({ id: SessionId('blank'), blank: true, projectionValues: { agentPreset: 'standard' } }))
    const first = controller.select('minimal')
    controller.stage('cordis', true)
    await controller.apply()
    expect(select).toHaveBeenCalledOnce()
    firstReply.resolve(refused ? refusal : { ok: true, value: 'minimal' })
    await first
    expect(controller.store.getSnapshot().current).toBe('cordis')
    await controller.apply()
    expect(select.mock.calls.map(call => call[1])).toEqual(['minimal', 'cordis'])
  })

  it.each([false, true])('serializes Settings choices and preserves each refusal (middle refused: %s)', async (refused) => {
    const refusal = { ok: false as const, error: new RemoteError('gateway/internal', 'selection refused', {}) }
    type Outcome = { ok: true; value: string } | typeof refusal
    const requests: { preset: string; outcome: ReturnType<typeof Promise.withResolvers<Outcome>> }[] = []
    const session = { id: SessionId('blank'), blank: true, projectionValues: { agentPreset: 'standard' } }
    const controller = new AgentPresetSeatController({
      ...developerTools(),
      remote: { agentPresets: { select: (_id: SessionId, preset: string) => {
        const outcome = Promise.withResolvers<Outcome>()
        requests.push({ preset, outcome })
        return outcome.promise
      } } },
    } as never, () => session)
    const first = controller.select('minimal')
    const second = controller.syncBlankSession(session.id, 'cordis')
    const third = controller.syncBlankSession(session.id, 'coding')
    expect(requests.map(request => request.preset)).toEqual(['minimal'])
    requests[0]!.outcome.resolve({ ok: true, value: 'minimal' })
    await first
    expect(requests.map(request => request.preset)).toEqual(['minimal', 'cordis'])
    requests[1]!.outcome.resolve(refused ? refusal : { ok: true, value: 'cordis' })
    await expect(second).resolves.toBe(refused ? 'selection refused' : undefined)
    expect(requests.map(request => request.preset)).toEqual(['minimal', 'cordis', 'coding'])
    requests[2]!.outcome.resolve({ ok: true, value: 'coding' })
    await third
    expect(controller.store.getSnapshot()).toMatchObject({ current: 'coding', busy: false })
  })

  it('does not apply a waiting Settings choice to a replacement binding', async () => {
    const reply = Promise.withResolvers<{ ok: true; value: string }>()
    const select = vi.fn(() => reply.promise)
    let current = { id: SessionId('first'), blank: true, projectionValues: { agentPreset: 'standard' } }
    const controller = new AgentPresetSeatController({ ...developerTools(), remote: { agentPresets: { select } } } as never, () => current)
    const first = controller.select('minimal')
    const settings = controller.syncBlankSession(current.id, 'cordis')
    current = { ...current, id: SessionId('replacement') }
    reply.resolve({ ok: true, value: 'minimal' })
    await Promise.all([first, settings])
    await controller.apply()
    expect(select).toHaveBeenCalledExactlyOnceWith(SessionId('first'), 'minimal')
  })

  it('does not capture a non-blank Session', () => {
    const controller = new AgentPresetSeatController({ ...developerTools() } as never, () => ({
      id: SessionId('started'), blank: false,
    }))

    expect(controller.blankSessionId()).toBeUndefined()
  })

  it('does not retarget a different blank Session after a Settings write', async () => {
    const select = vi.fn(() => Promise.resolve({ ok: true as const, value: 'minimal' }))
    let current = {
      id: SessionId('first'), blank: true, projectionValues: { agentPreset: 'standard' },
    }
    const controller = new AgentPresetSeatController({
      ...developerTools(),
      remote: { agentPresets: { select } },
    } as never, () => current)
    const captured = controller.blankSessionId()
    if (captured === undefined) throw new Error('expected a blank Session')
    current = {
      id: SessionId('second'), blank: true, projectionValues: { agentPreset: 'standard' },
    }

    await controller.syncBlankSession(captured, 'minimal')

    expect(select).not.toHaveBeenCalled()
  })

  it('uses the deployment default without a Session and clears it for an uncomposed Session', async () => {
    const state: { current?: { id: SessionId; blank: boolean } } = {}
    const controller = new AgentPresetSeatController({
      ...developerTools(),
      remote: {
        agentPresets: {
          list: () => Promise.resolve(ROSTER_ONE),
        },
      },
    } as never, () => state.current)

    await controller.load()
    await controller.apply()
    expect(controller.store.getSnapshot().current).toBe('standard')

    state.current = { id: SessionId('uncomposed'), blank: true }
    await controller.apply()
    expect(controller.store.getSnapshot().current).toBe('')
  })

  it('restores an empty current value after a refused switch for an uncomposed Session', async () => {
    const select = () => Promise.resolve({
      ok: false as const, error: new RemoteError('gateway/internal', 'selection rejected', {}),
    })
    const controller = new AgentPresetSeatController({
      ...developerTools(),
      remote: { agentPresets: { select } },
    } as never, () => ({ id: SessionId('uncomposed'), blank: true }))

    await controller.select('minimal')

    expect(controller.store.getSnapshot()).toMatchObject({
      busy: false, current: '', error: 'selection rejected',
    })
  })

  it('keeps the bare cause of a mount failure, not the frame that names the preset again', async () => {
    const reason = 'failed to import loader entry ctx (@deepseek-ai/dsh-gone): Cannot find package'
    const controller = new AgentPresetSeatController({
      ...developerTools(),
      remote: {
        agentPresets: {
          select: () => Promise.resolve({
            ok: false as const,
            error: new RemoteError(
              'agent-preset/invalid',
              `agent-presets: preset "broken" failed to mount: ${reason}`,
              { agentPreset: 'broken', reason },
            ),
          }),
        },
      },
    } as never, () => ({ id: SessionId('uncomposed'), blank: true }))

    // The surface reporting this names the preset itself, so carrying the
    // roster's own "preset X failed to mount" frame would say it twice.
    expect(await controller.select('broken')).toBe(reason)
    expect(controller.store.getSnapshot().error).toBe(reason)
  })
})
