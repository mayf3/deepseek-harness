// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SubagentCard, type SubagentCardProps } from '../src/client/SubagentCard.tsx'
import type { SubagentLimitsCardState } from '../src/client/subagent-limits-card-controller.ts'
import { AgentLoopCard } from '../src/client/AgentLoopCard.tsx'
import type { AgentLoopCardProps } from '../src/client/AgentLoopCard.tsx'
import { BashCard } from '../src/client/BashCard.tsx'
import type { BashCardProps } from '../src/client/BashCard.tsx'
import { ConfigurablePluginsTab } from '../src/client/ConfigurablePluginsTab.tsx'
import type { ConfigurablePluginsTabProps } from '../src/client/ConfigurablePluginsTab.tsx'
import { PluginsSettingsSection } from '../src/client/PluginsSettingsSection.tsx'
import type { PluginsSettingsSectionProps, PluginsSettingsTabEntry } from '../src/client/PluginsSettingsSection.tsx'
import { WebSearchCard } from '../src/client/WebSearchCard.tsx'
import type { WebSearchCardProps } from '../src/client/WebSearchCard.tsx'
import type { AgentLoopCardState } from '../src/client/agent-loop-card-controller.ts'
import type { BashCardState } from '../src/client/bash-card-controller.ts'
import type { CardFieldState, CardShell } from '../src/client/card-form.ts'
import type { ConfigurablePluginsTabState } from '../src/client/tab-store.ts'
import type { WebSearchCardState } from '../src/client/web-search-card-controller.ts'
import type { SubagentModelSelectionCardState } from '../src/client/subagent-model-selection-card-controller.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t = (key: keyof typeof en) => en[key]

const settled: CardShell = {
  available: true,
  writable: true,
  dirty: false,
  invalid: false,
  saving: false,
  failed: false,
}

function field(text: string, rest: Partial<CardFieldState> = {}): CardFieldState {
  return { text, overridden: false, invalid: false, ...rest }
}

function cardActions() {
  return { edit: vi.fn(), resetField: vi.fn(), save: vi.fn(), discard: vi.fn() }
}

function renderSection(rows: readonly PluginsSettingsTabEntry[]) {
  const props = {
    t,
    useTabs: (selector: (value: readonly PluginsSettingsTabEntry[]) => unknown) => selector(rows),
    renderSlot: (_name: string, _owner: unknown, options: { only?: string }) => (
      <span>{options.only}</span>
    ),
  } as unknown as PluginsSettingsSectionProps
  render(<PluginsSettingsSection {...props} />)
}

function renderConfigurable(namespaces: string[], cards: Record<string, string> = {}, loaded = true) {
  const store = createSnapshotStore<ConfigurablePluginsTabState>({ loaded, namespaces })
  const props = {
    t,
    useConfigurablePlugins: bindSnapshotSelector(store),
    renderSlot: (_name: string, _owner: object, opts?: { entryKey?: string }) => {
      const card = opts?.entryKey === undefined ? undefined : cards[opts.entryKey]
      return card === undefined ? null : <li>{card}</li>
    },
  } as unknown as ConfigurablePluginsTabProps
  render(<ConfigurablePluginsTab {...props} />)
}

function renderBashCard(state: Partial<BashCardState> = {}) {
  const store = createSnapshotStore<BashCardState>({
    ...settled,
    timeoutMs: field('60000'),
    maxOutputBytes: field('64000'),
    ...state,
  })
  const actions = cardActions()
  const props = { ...actions, t, useBashCard: bindSnapshotSelector(store) } as unknown as BashCardProps
  render(<BashCard {...props} />)
  return { actions, store }
}

function renderBash(state: Partial<BashCardState> = {}) {
  return renderBashCard(state).actions
}

function renderSubagent(
  limitState: Partial<SubagentLimitsCardState> = {},
  modelState: Partial<SubagentModelSelectionCardState> = {},
  fallback = false,
) {
  const limits = createSnapshotStore<SubagentLimitsCardState>({
    ...settled,
    maxDepth: field('3'),
    maxActiveSubagents: field('8'),
    ...limitState,
  })
  const models = createSnapshotStore<SubagentModelSelectionCardState>({
    ...settled,
    enabled: false,
    candidates: [],
    catalogStatus: 'idle',
    catalogPartial: false,
    conflicted: false,
    ...modelState,
  })
  const actions = {
    editLimit: vi.fn(),
    resetLimit: vi.fn(),
    toggleEnabled: vi.fn(),
    toggleModel: vi.fn(),
    retryCatalog: vi.fn(),
    save: vi.fn(),
    discard: vi.fn(),
  }
  const props = {
    ...actions,
    t,
    fallback,
    useSubagentLimitsCard: bindSnapshotSelector(limits),
    useSubagentModelSelectionCard: bindSnapshotSelector(models),
  } as unknown as SubagentCardProps
  render(<SubagentCard {...props} />)
  return { actions, limits, models }
}

function renderSubagentModelSelection(state: Partial<SubagentModelSelectionCardState> = {}) {
  return renderSubagent({ available: false }, state, true).actions
}

describe('PluginsSettingsSection', () => {
  it('says so when no plugin contributed a tab', () => {
    renderSection([])

    expect(screen.getByText(en.empty)).toBeTruthy()
    expect(screen.queryByRole('tab')).toBeNull()
  })

  it('defaults to the first ordered tab and mounts another only after selection', () => {
    renderSection([
      { id: 'configurable', order: 0, label: en.configurableTab },
      { id: 'all', order: 10, label: 'Plugin list' },
    ])

    const configurable = screen.getByRole('tab', { name: en.configurableTab })
    const all = screen.getByRole('tab', { name: 'Plugin list' })
    expect(configurable.getAttribute('aria-selected')).toBe('true')
    expect(screen.getByText('configurable')).toBeTruthy()
    expect(screen.queryByText('all')).toBeNull()

    fireEvent.click(all)
    expect(all.getAttribute('aria-selected')).toBe('true')
    expect(screen.getByText('all')).toBeTruthy()
    expect(screen.getByText('configurable').closest('[role="tabpanel"]')).toHaveProperty('hidden', true)

    fireEvent.click(configurable)
    expect(configurable.getAttribute('aria-selected')).toBe('true')
    expect(screen.getByText('all').closest('[role="tabpanel"]')).toHaveProperty('hidden', true)
  })

  it('leads with its own heading and intro', () => {
    renderSection([{ id: 'configurable', order: 0, label: en.configurableTab }])

    expect(screen.getByRole('heading', { name: en.title })).toBeTruthy()
    expect(screen.getByText(en.intro)).toBeTruthy()
  })

  it('moves focus and selection with standard horizontal tab keys', () => {
    renderSection([
      { id: 'configurable', order: 0, label: en.configurableTab },
      { id: 'all', order: 10, label: 'Plugin list' },
      { id: 'diagnostics', order: 20, label: 'Diagnostics' },
    ])

    const configurable = screen.getByRole('tab', { name: en.configurableTab })
    const all = screen.getByRole('tab', { name: 'Plugin list' })
    const diagnostics = screen.getByRole('tab', { name: 'Diagnostics' })
    expect(configurable.getAttribute('tabindex')).toBe('0')
    expect(all.getAttribute('tabindex')).toBe('-1')

    configurable.focus()
    fireEvent.keyDown(configurable, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(all)
    expect(all.getAttribute('aria-selected')).toBe('true')

    fireEvent.keyDown(all, { key: 'End' })
    expect(document.activeElement).toBe(diagnostics)
    fireEvent.keyDown(diagnostics, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(configurable)
    fireEvent.keyDown(configurable, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(diagnostics)
    fireEvent.keyDown(diagnostics, { key: 'Home' })
    expect(document.activeElement).toBe(configurable)

    fireEvent.keyDown(configurable, { key: 'Escape' })
    expect(document.activeElement).toBe(configurable)
    expect(configurable.getAttribute('aria-selected')).toBe('true')
  })
})

describe('ConfigurablePluginsTab', () => {
  it('says so when no plugin contributed a card', () => {
    renderConfigurable([], { bash: 'shell' })

    expect(screen.getByText(en.empty)).toBeTruthy()
    expect(screen.queryByText('shell')).toBeNull()
  })

  it('withholds the empty line until the Host has answered once', () => {
    // An unanswered read is not the statement that this deployment configures
    // no plugin; saying it anyway would flash a wrong answer on every open.
    renderConfigurable([], { bash: 'shell' }, false)

    expect(screen.queryByText(en.empty)).toBeNull()
  })

  it('dispatches one card per namespace, keyed by it', () => {
    renderConfigurable(['bash', 'agent-loop'], { bash: 'shell', 'agent-loop': 'loop' })

    expect(screen.getAllByRole('listitem').map(item => item.textContent)).toEqual(['shell', 'loop'])
    expect(screen.queryByText(en.empty)).toBeNull()
  })
})

describe('BashCard', () => {
  it('renders nothing while its namespace is unavailable', () => {
    const { container } = render(<div />)
    renderBash({ available: false })

    expect(container.textContent).toBe('')
    expect(screen.queryByText(en.bashTitle)).toBeNull()
  })

  it('shows the plugin and reveals its fields only once expanded', () => {
    renderBash()
    expect(screen.getByText(en.bashTitle)).toBeTruthy()
    expect(screen.queryByLabelText(en.bashTimeoutMs)).toBeNull()

    fireEvent.click(screen.getByText(en.bashTitle))

    expect(screen.getByLabelText(en.bashTimeoutMs)).toBeTruthy()
    expect(screen.getByLabelText(en.bashMaxOutputBytes)).toBeTruthy()
  })

  it('stages an edit instead of writing it', () => {
    const actions = renderBash()
    fireEvent.click(screen.getByText(en.bashTitle))

    fireEvent.change(screen.getByLabelText(en.bashTimeoutMs), { target: { value: '9000' } })

    expect(actions.edit).toHaveBeenCalledWith('timeoutMs', '9000')
    expect(actions.save).not.toHaveBeenCalled()
  })

  it('offers the reset for an overridden field only', () => {
    const actions = renderBash({ timeoutMs: field('9000', { overridden: true }) })
    fireEvent.click(screen.getByText(en.bashTitle))

    // One badge and one reset: the output cap is still inherited.
    expect(screen.getAllByText(en.overridden)).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: en.reset }))

    expect(actions.resetField).toHaveBeenCalledWith('timeoutMs')
  })

  it('addresses each of its two fields separately', () => {
    const actions = renderBash({ maxOutputBytes: field('64000', { overridden: true }) })
    fireEvent.click(screen.getByText(en.bashTitle))

    fireEvent.change(screen.getByLabelText(en.bashMaxOutputBytes), { target: { value: '1024' } })
    fireEvent.click(screen.getByRole('button', { name: en.reset }))

    expect(actions.edit).toHaveBeenCalledWith('maxOutputBytes', '1024')
    expect(actions.resetField).toHaveBeenCalledWith('maxOutputBytes')
  })

  it('keeps save and discard inert until something is staged', () => {
    renderBash()
    fireEvent.click(screen.getByText(en.bashTitle))

    expect(screen.getByRole('button', { name: en.save })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: en.discard })).toHaveProperty('disabled', true)
    expect(screen.queryByText(en.unsaved)).toBeNull()
  })

  it('writes the staged edits when saved, and drops them when discarded', () => {
    const actions = renderBash({ dirty: true, timeoutMs: field('9000', { overridden: true }) })
    fireEvent.click(screen.getByText(en.bashTitle))

    fireEvent.click(screen.getByRole('button', { name: en.save }))
    fireEvent.click(screen.getByRole('button', { name: en.discard }))

    expect(actions.save).toHaveBeenCalledOnce()
    expect(actions.discard).toHaveBeenCalledOnce()
  })

  it('marks a card holding unsaved edits, collapsed or not', () => {
    renderBash({ dirty: true })

    expect(screen.getByText(en.unsaved)).toBeTruthy()
  })

  it('blocks the save while a draft is invalid, and says why', () => {
    renderBash({ dirty: true, invalid: true, timeoutMs: field('soon', { invalid: true }) })
    fireEvent.click(screen.getByText(en.bashTitle))

    expect(screen.getByRole('button', { name: en.save })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: en.discard })).toHaveProperty('disabled', false)
    expect(screen.getByText(en.invalidNumber)).toBeTruthy()
  })

  it('reports a save in flight and refuses another', () => {
    renderBash({ dirty: true, saving: true })
    fireEvent.click(screen.getByText(en.bashTitle))

    expect(screen.getByRole('button', { name: en.saving })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: en.discard })).toHaveProperty('disabled', true)
  })

  it('reports a save the deployment did not accept', () => {
    renderBash({ dirty: true, failed: true })
    fireEvent.click(screen.getByText(en.bashTitle))

    expect(screen.getByText(en.saveFailed)).toBeTruthy()
  })

  it('says the document is read-only and disables its controls', () => {
    renderBash({ writable: false })
    fireEvent.click(screen.getByText(en.bashTitle))

    expect(screen.getByRole('status')).toHaveProperty('textContent', en.readOnly)
    expect(screen.getByLabelText(en.bashTimeoutMs)).toHaveProperty('disabled', true)
  })

  it('collapses again on a second click', () => {
    renderBash()
    fireEvent.click(screen.getByText(en.bashTitle))
    expect(screen.getByLabelText(en.bashTimeoutMs)).toBeTruthy()

    fireEvent.click(screen.getByText(en.bashTitle))

    expect(screen.queryByLabelText(en.bashTimeoutMs)).toBeNull()
  })

  it('collapses after a successful save settles', () => {
    const { actions, store } = renderBashCard({ dirty: true })
    fireEvent.click(screen.getByText(en.bashTitle))
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    expect(actions.save).toHaveBeenCalledOnce()

    act(() => { store.set({ ...store.getSnapshot(), saving: true }) })
    act(() => { store.set({ ...store.getSnapshot(), dirty: false, saving: false }) })

    expect(screen.queryByLabelText(en.bashTimeoutMs)).toBeNull()
  })

  it('keeps a failed save open', () => {
    const { store } = renderBashCard({ dirty: true })
    fireEvent.click(screen.getByText(en.bashTitle))
    fireEvent.click(screen.getByRole('button', { name: en.save }))

    act(() => { store.set({ ...store.getSnapshot(), saving: true }) })
    act(() => { store.set({ ...store.getSnapshot(), failed: true, saving: false }) })

    expect(screen.getByLabelText(en.bashTimeoutMs)).toBeTruthy()
    expect(screen.getByText(en.saveFailed)).toBeTruthy()
  })
})

describe('Subagent model selection fields', () => {
  it('renders the default-off preference in its staged plugin card', () => {
    const actions = renderSubagentModelSelection()
    fireEvent.click(screen.getByText(en.subagentTitle))

    const control = screen.getByRole('switch', { name: en.subagentModelSelectionToggle })
    expect(control.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(control)

    expect(actions.toggleEnabled).toHaveBeenCalledOnce()
  })

  it('groups available adapter candidates by provider', () => {
    const actions = renderSubagentModelSelection({
      enabled: true,
      candidates: [
        {
          key: 'alpha\0fast',
          provider: 'alpha',
          model: 'fast',
          providerName: 'Alpha API',
          modelName: 'Fast',
          available: true,
          selected: true,
        },
        {
          key: 'alpha\0deep',
          provider: 'alpha',
          model: 'deep',
          providerName: 'Alpha API',
          modelName: 'Deep',
          available: true,
          selected: false,
        },
      ],
      catalogStatus: 'ready',
    })
    fireEvent.click(screen.getByText(en.subagentTitle))

    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true')
    expect(screen.getByText('Alpha API', { exact: true })).toBeTruthy()
    fireEvent.click(screen.getByRole('checkbox', { name: /Fast/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: /Deep/ }))
    expect(actions.toggleModel).toHaveBeenCalledWith('alpha\0fast')
    expect(actions.toggleModel).toHaveBeenCalledWith('alpha\0deep')
  })

  it('renders directory progress, failures, unavailable routes, and validation', () => {
    renderSubagentModelSelection({ enabled: true, catalogStatus: 'loading', invalid: true })
    fireEvent.click(screen.getByText(en.subagentTitle))
    expect(screen.getByText(en.subagentModelSelectionLoading)).toBeTruthy()
    expect(screen.getByText(en.subagentModelSelectionRequired)).toBeTruthy()

    cleanup()
    const errorActions = renderSubagentModelSelection({ enabled: true, catalogStatus: 'error' })
    fireEvent.click(screen.getByText(en.subagentTitle))
    fireEvent.click(screen.getByRole('button', { name: en.subagentModelSelectionRetry }))
    expect(errorActions.retryCatalog).toHaveBeenCalledOnce()

    cleanup()
    renderSubagentModelSelection({
      enabled: true,
      catalogStatus: 'ready',
      catalogPartial: true,
      candidates: [{
        key: 'legacy\0old',
        provider: 'legacy',
        model: 'old',
        providerName: 'legacy',
        modelName: 'old',
        available: false,
        selected: true,
      }],
    })
    fireEvent.click(screen.getByText(en.subagentTitle))
    expect(screen.getByText(en.subagentModelSelectionPartial)).toBeTruthy()
    expect(screen.getByText(en.subagentModelSelectionUnavailable)).toBeTruthy()
    expect(screen.getByText(en.subagentModelSelectionUnavailableGroup)).toBeTruthy()

    cleanup()
    renderSubagentModelSelection({ enabled: true, catalogStatus: 'ready' })
    fireEvent.click(screen.getByText(en.subagentTitle))
    expect(screen.getByText(en.subagentModelSelectionEmpty)).toBeTruthy()
  })

  it('distinguishes a stale draft from a rejected save', () => {
    renderSubagentModelSelection({ dirty: true, conflicted: true })
    fireEvent.click(screen.getByText(en.subagentTitle))

    expect(screen.getByText(en.subagentModelSelectionConflict)).toBeTruthy()
    expect(screen.queryByText(en.saveFailed)).toBeNull()
  })

  it('stays hidden when unavailable and disables writes when read-only', () => {
    renderSubagentModelSelection({ available: false })
    expect(screen.queryByText(en.subagentTitle)).toBeNull()

    cleanup()
    const actions = renderSubagentModelSelection({ writable: false })
    fireEvent.click(screen.getByText(en.subagentTitle))
    const control = screen.getByRole('switch') as HTMLButtonElement
    expect(control.disabled).toBe(true)
    fireEvent.click(control)
    expect(actions.toggleEnabled).not.toHaveBeenCalled()
  })
})

describe('AgentLoopCard', () => {
  it('stages and saves the only field it owns', () => {
    const store = createSnapshotStore<AgentLoopCardState>({
      ...settled,
      dirty: true,
      maxParallelToolCalls: field('10'),
    })
    const actions = cardActions()
    const props = {
      ...actions,
      t,
      useAgentLoopCard: bindSnapshotSelector(store),
    } as unknown as AgentLoopCardProps
    render(<AgentLoopCard {...props} />)

    fireEvent.click(screen.getByText(en.agentLoopTitle))
    fireEvent.change(screen.getByLabelText(en.agentLoopMaxParallel), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: en.save }))

    expect(actions.edit).toHaveBeenCalledWith('maxParallelToolCalls', '2')
    expect(actions.save).toHaveBeenCalledOnce()
  })

  it('stages a reset for the field it owns', () => {
    const store = createSnapshotStore<AgentLoopCardState>({
      ...settled,
      maxParallelToolCalls: field('2', { overridden: true }),
    })
    const actions = cardActions()
    const props = {
      ...actions,
      t,
      useAgentLoopCard: bindSnapshotSelector(store),
    } as unknown as AgentLoopCardProps
    render(<AgentLoopCard {...props} />)

    fireEvent.click(screen.getByText(en.agentLoopTitle))
    fireEvent.click(screen.getByRole('button', { name: en.reset }))

    expect(actions.resetField).toHaveBeenCalledWith('maxParallelToolCalls')
  })
})

describe('WebSearchCard', () => {
  function renderWebSearch(state: Partial<WebSearchCardState> = {}) {
    const store = createSnapshotStore<WebSearchCardState>({
      ...settled,
      baseURL: field(''),
      maxUses: field('5'),
      apiKey: field(''),
      apiKeyConfigured: false,
      apiKeyWritable: true,
      ...state,
    })
    const actions = cardActions()
    const props = { ...actions, t, useWebSearchCard: bindSnapshotSelector(store) } as unknown as WebSearchCardProps
    render(<WebSearchCard {...props} />)
    return actions
  }

  it('reports whether a key is configured without ever showing one', () => {
    renderWebSearch({ apiKeyConfigured: true })
    fireEvent.click(screen.getByText(en.webSearchTitle))

    expect(screen.getByText(en.webSearchApiKeySet)).toBeTruthy()
    expect(screen.getByLabelText(en.webSearchApiKey)).toHaveProperty('type', 'password')
  })

  it('keeps the key control usable while the settings document is read-only', () => {
    const actions = renderWebSearch({ writable: false })
    fireEvent.click(screen.getByText(en.webSearchTitle))

    const key = screen.getByLabelText(en.webSearchApiKey)
    expect(key).toHaveProperty('disabled', false)
    expect(screen.getByLabelText(en.webSearchBaseUrl)).toHaveProperty('disabled', true)

    fireEvent.change(key, { target: { value: 'ds-secret' } })

    expect(actions.edit).toHaveBeenCalledWith('apiKey', 'ds-secret')
  })

  it('disables the key control when the reference itself is not writable', () => {
    // A key coming from the process environment: the settings document is
    // writable, the credential is not.
    renderWebSearch({ apiKeyConfigured: true, apiKeyWritable: false })
    fireEvent.click(screen.getByText(en.webSearchTitle))

    expect(screen.getByLabelText(en.webSearchApiKey)).toHaveProperty('disabled', true)
    expect(screen.getByLabelText(en.webSearchBaseUrl)).toHaveProperty('disabled', false)
  })

  it('stages the endpoint, the search budget, and their resets', () => {
    const actions = renderWebSearch({
      baseURL: field('https://search.test/v1', { overridden: true }),
      maxUses: field('3', { overridden: true }),
    })
    fireEvent.click(screen.getByText(en.webSearchTitle))

    fireEvent.change(screen.getByLabelText(en.webSearchBaseUrl), { target: { value: 'https://other.test' } })
    fireEvent.change(screen.getByLabelText(en.webSearchMaxUses), { target: { value: '4' } })
    const resets = screen.getAllByRole('button', { name: en.reset })
    expect(resets).toHaveLength(2)
    for (const reset of resets) fireEvent.click(reset)

    expect(actions.edit.mock.calls).toEqual([
      ['baseURL', 'https://other.test'],
      ['maxUses', '4'],
    ])
    expect(actions.resetField.mock.calls).toEqual([['baseURL'], ['maxUses']])
  })
})


describe('SubagentCard', () => {
  it('shows both sections under one disclosure and save footer', () => {
    renderSubagent({ dirty: true })
    fireEvent.click(screen.getByText(en.subagentTitle))

    expect(screen.getByRole('heading', { name: en.subagentLimitsTitle })).toBeTruthy()
    expect(screen.getByRole('heading', { name: en.subagentModelSelectionTitle })).toBeTruthy()
    expect(screen.getAllByRole('button', { name: en.save })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: en.discard })).toHaveLength(1)
  })

  it('reveals field rules on demand without changing staged values', () => {
    renderSubagent({ dirty: true, maxDepth: field('2') })
    fireEvent.click(screen.getByText(en.subagentTitle))
    const depthHelp = screen.getByRole('button', { name: en.subagentDepthHelpLabel })
    const capacityHelp = screen.getByRole('button', { name: en.subagentCapacityHelpLabel })
    expect(depthHelp.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText(en.subagentDepthHelp)).toBeNull()
    expect(screen.queryByText(en.subagentCapacityHelp)).toBeNull()

    fireEvent.click(depthHelp)
    expect(depthHelp.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('region', { name: en.subagentDepthHelpLabel })).toBeTruthy()
    expect(screen.getByText(en.subagentDepthHelp)).toBeTruthy()
    expect(screen.getByRole('table', { name: en.subagentDepthHelpLabel })).toBeTruthy()
    expect(screen.getByRole('row', { name: `0 ${en.subagentDepthZero}` })).toBeTruthy()
    expect(screen.getByRole('row', { name: `1 ${en.subagentDepthOne}` })).toBeTruthy()
    expect(screen.getByText(en.subagentDepthOverride)).toBeTruthy()
    fireEvent.click(capacityHelp)
    expect(screen.getByText(en.subagentCapacityHelp)).toBeTruthy()
    fireEvent.click(depthHelp)
    expect(screen.queryByText(en.subagentDepthHelp)).toBeNull()
    expect(screen.getByLabelText(en.subagentMaxDepth)).toHaveProperty('value', '2')
    expect(screen.getByRole('button', { name: en.save })).toHaveProperty('disabled', false)
  })

  it('keeps validation visible when the rules are collapsed and links it to the input', () => {
    renderSubagent({ dirty: true, invalid: true, maxDepth: field('1.5', { invalid: true }) })
    fireEvent.click(screen.getByText(en.subagentTitle))
    const depth = screen.getByLabelText(en.subagentMaxDepth)
    const messageId = depth.getAttribute('aria-describedby')!
    expect(document.getElementById(messageId)?.textContent).toBe(en.subagentDepthInvalid)
    expect(screen.queryByRole('region', { name: en.subagentDepthHelpLabel })).toBeNull()
  })

  it('edits and resets limits through the shared card', () => {
    const { actions, limits } = renderSubagent({
      dirty: true,
      maxDepth: field('3', { overridden: true }),
      maxActiveSubagents: field('8', { overridden: true }),
    })
    fireEvent.click(screen.getByText(en.subagentTitle))
    fireEvent.change(screen.getByLabelText(en.subagentMaxDepth), { target: { value: '2' } })
    fireEvent.change(screen.getByLabelText(en.subagentMaxActive), { target: { value: '12' } })
    expect(actions.editLimit.mock.calls).toEqual([['maxDepth', '2'], ['maxActiveSubagents', '12']])
    for (const button of screen.getAllByRole('button', { name: en.reset })) fireEvent.click(button)
    expect(actions.resetLimit.mock.calls).toEqual([['maxDepth'], ['maxActiveSubagents']])
    act(() => { limits.set({ ...limits.getSnapshot(), writable: false }) })
    expect(screen.getByLabelText(en.subagentMaxActive)).toHaveProperty('disabled', true)
  })

  it('blocks saving both sections when a model selection is invalid or conflicted', () => {
    const { models } = renderSubagent({ dirty: true }, { dirty: true, invalid: true })
    fireEvent.click(screen.getByText(en.subagentTitle))
    expect(screen.getByRole('button', { name: en.save })).toHaveProperty('disabled', true)
    act(() => { models.set({ ...models.getSnapshot(), invalid: false, conflicted: true }) })
    expect(screen.getByRole('button', { name: en.save })).toHaveProperty('disabled', true)
  })

  it('locks both sections while either is saving and collapses after both settle', () => {
    const { limits, models } = renderSubagent({ dirty: true }, { dirty: true })
    fireEvent.click(screen.getByText(en.subagentTitle))
    act(() => {
      limits.set({ ...limits.getSnapshot(), saving: true })
      models.set({ ...models.getSnapshot(), saving: true })
    })
    expect(screen.getByLabelText(en.subagentMaxDepth)).toHaveProperty('disabled', true)
    expect(screen.getByRole('switch')).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: en.discard })).toHaveProperty('disabled', true)
    act(() => { limits.set({ ...limits.getSnapshot(), saving: false, dirty: false }) })
    expect(screen.getByRole('switch')).toHaveProperty('disabled', true)
    act(() => { models.set({ ...models.getSnapshot(), saving: false, dirty: false }) })
    expect(screen.queryByRole('switch')).toBeNull()
  })

  it('keeps a rejected section open after the other section saves', () => {
    const { limits, models } = renderSubagent({ dirty: true }, { dirty: true })
    fireEvent.click(screen.getByText(en.subagentTitle))
    act(() => {
      limits.set({ ...limits.getSnapshot(), saving: true })
      models.set({ ...models.getSnapshot(), saving: true })
    })
    act(() => {
      limits.set({ ...limits.getSnapshot(), saving: false, dirty: false })
      models.set({ ...models.getSnapshot(), saving: false, failed: true })
    })
    expect(screen.getByRole('switch')).toBeTruthy()
    expect(screen.getByText(en.saveFailed)).toBeTruthy()
    expect(screen.getByRole('button', { name: en.save })).toHaveProperty('disabled', false)
  })

  it('renders the model-only fallback only when the limits namespace is absent', () => {
    renderSubagent({}, {}, true)
    expect(screen.queryByText(en.subagentTitle)).toBeNull()
    cleanup()
    renderSubagent({ available: false }, {}, true)
    fireEvent.click(screen.getByText(en.subagentTitle))
    expect(screen.getByRole('switch')).toBeTruthy()
    expect(screen.queryByLabelText(en.subagentMaxDepth)).toBeNull()
  })
})
