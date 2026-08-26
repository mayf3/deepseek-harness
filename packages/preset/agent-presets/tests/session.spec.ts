/** The Session projection that records which preset a Session runs. */

import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { agentPresetProjectionDefinition } from '../src/session.ts'

/** One logged selection, as `agentPreset.select` appends it. */
function selected(agentPreset: string, seq: number): SessionEvent {
  return { type: 'agent-preset/selected', seq, time: seq, data: { agentPreset } }
}

describe('agent preset selection projection', () => {
  it('starts from the creation header, including no configured preset', () => {
    const initial = agentPresetProjectionDefinition.init()
    expect(agentPresetProjectionDefinition.applyHeaderSeed(initial, 'standard')).toBe('standard')
    expect(agentPresetProjectionDefinition.applyHeaderSeed(initial, undefined)).toBeNull()
  })

  it('starts from the header and keeps the latest selected preset', () => {
    const definition = agentPresetProjectionDefinition
    let state = definition.applyHeaderSeed(definition.init(), 'standard')
    expect(state).toBe('standard')

    state = definition.apply(state, selected('minimal', 0))
    state = definition.apply(state, {
      type: 'turn/end', seq: 1, time: 1, data: { turn: 1, reason: { kind: 'completed' } },
    })
    state = definition.apply(state, selected('cordis', 2))

    expect(definition.wire.view(state)).toBe('cordis')
    expect(definition.stateSchema.parse(state)).toBe('cordis')
  })
})
