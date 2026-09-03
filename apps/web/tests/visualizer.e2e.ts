/** Keyless assembled-Web proof for the opt-in Visualizer Host authority. */

import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type { ReplayProviderConfig } from '@deepseek-ai/dsh-llm-replay'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent-presets'
import {
  assertFixtureInventory,
  launchWebScaffold,
  recordFixture,
  webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/visualizer-host', import.meta.url))
const FIXTURE = join(SNAPSHOT_DIR, 'session.v2.jsonl')
const PROMPT = 'Call widget_guidelines with the interactive and chart modules, then reply exactly "Guidance loaded." Do not call show_widget.'
const VISUALIZER_TOOLS = ['show_widget', 'widget_guidelines']
const RECORDED_PROVIDER_CATALOG = [{
  id: 'deepseek-official',
  name: 'DeepSeek',
  models: [{
    id: 'deepseek-v4-flash',
    name: 'DeepSeek-V4-Flash',
    contextWindow: 1_000_000,
    defaultMaxTokens: 256_000,
    reasoningEfforts: ['off', 'low', 'high', 'max'],
    defaultReasoningEffort: 'high',
  }],
}] satisfies readonly ReplayProviderConfig[]
const MODE = webSnapshotMode()

describe('Visualizer Host explicit composition', () => {
  let scaffold: WebScaffold
  let agentHandle: AgentHandle
  let authorityId: string

  beforeAll(async () => {
    scaffold = await launchWebScaffold(MODE === 'record'
      ? {}
      : { replayFixture: FIXTURE, replayProviders: [...RECORDED_PROVIDER_CATALOG] })
    const presetKey = await scaffold.ctx.agentPresets.standingKeyFor('standard')
    authorityId = await scaffold.ctx.loader.create({ name: '@deepseek-ai/dsh-tool-visualizer' })
    await scaffold.ctx.loader.await()
    await vi.waitFor(() => {
      expect(scaffold.ctx.tools.schemas(presetKey).map(schema => schema.name)
        .filter(name => VISUALIZER_TOOLS.includes(name)).sort()).toEqual(VISUALIZER_TOOLS)
    })
    agentHandle = await scaffold.ctx.agents.create({
      sessionId: SessionId('visualizer-host-snapshot'),
      meta: { cwd: scaffold.workspaceCwd, agentPreset: 'standard' },
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      setup: agentCtx => scaffold.ctx.agentPresets.mount(agentCtx, 'standard').then(() => undefined),
    })
    expect(scaffold.ctx.tools.schemas(agentHandle.agent).map(schema => schema.name)
      .filter(name => VISUALIZER_TOOLS.includes(name)).sort()).toEqual(VISUALIZER_TOOLS)
    agentHandle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: PROMPT }],
      source: { kind: 'user' },
    }))
    await agentHandle.agent.whenIdle()
    if (MODE === 'record') await recordFixture(scaffold, agentHandle.agent.session.id, FIXTURE)
  })

  afterAll(async () => {
    const failures: unknown[] = []
    await agentHandle?.dispose().catch((error: unknown) => failures.push(error))
    if (authorityId !== undefined) {
      await scaffold.ctx.loader.remove(authorityId).catch((error: unknown) => failures.push(error))
    }
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'Visualizer Host snapshot teardown failed')
  })

  it('records the prompt plus two schemas from an explicit Host composition', async () => {
    expect(scaffold.ctx.get('visualizer')).toBeDefined()

    const requestHeader = agentHandle.agent.session.requestHeader()
    if (requestHeader === undefined) throw new Error('the Visualizer Host scenario issued no model request')
    expect(requestHeader.system).toContain('Use show_widget for a temporary inline visual')
    expect(requestHeader.tools?.map(schema => schema.name).filter(name => VISUALIZER_TOOLS.includes(name)).sort())
      .toEqual(VISUALIZER_TOOLS)
    expect(requestHeader.tools?.toSorted((left, right) => left.name.localeCompare(right.name)))
      .toEqual(scaffold.ctx.tools.schemas(agentHandle.agent).toSorted((left, right) => left.name.localeCompare(right.name)))

    await assertFixtureInventory(SNAPSHOT_DIR, [
      'session.jsonl',
      'system-prompt.expected.md',
      'tool-schemas.expected.json',
    ])
  })
})
