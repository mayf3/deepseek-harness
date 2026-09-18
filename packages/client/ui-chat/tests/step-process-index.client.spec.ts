/** Process projection keeps streaming work local to the affected group. */
import { describe, expect, it, vi } from 'vitest'
import type { ChatNode } from '../src/client/contract/chat-nodes.ts'
import { ChatSnapshotBuilder } from '../src/client/conversation-nodes/chat-snapshot-builder.ts'
import { ChatStepProcessProjector, processLayoutChanged } from '../src/client/conversation-nodes/step-process-index.ts'
import { chatSnapshotFixture } from './chat-snapshot-fixture.client.ts'

function history(turns: number) {
  return chatSnapshotFixture({
    nodes: Array.from({ length: turns }, (_, i) => ({
      kind: 'assistant' as const, seq: i + 1, time: i, turn: i + 1, step: 1,
      blocks: [{ kind: 'reasoning' as const, text: 'Inspect history' }, { kind: 'text' as const, text: 'Done' }],
    })),
    partial: { turn: turns + 1, step: 1, blocks: [{ kind: 'reasoning', text: 'Inspect current work' }] },
  })
}

describe('step process projection', () => {
  it.each([10, 1000])('reads only the changed group with %i historical turns', (turns) => {
    const snapshot = history(turns)
    const index = new ChatStepProcessProjector()
    index.replace(snapshot)
    const layout = index.layout
    const oldGroups = layout.filter(range => range.process).map(range => index.get(range.key)!)
    const live = oldGroups.at(-1)!
    const node = live.nodes[0]!
    expect(node.kind).toBe('assistant-step')
    if (node.kind !== 'assistant-step') throw new Error('missing live assistant')
    const changed: ChatNode<'assistant-step'> = {
      ...node, data: { ...node.data, blocks: [{ kind: 'reasoning', text: 'Inspect current work in more detail' }] },
    }
    expect(processLayoutChanged(node, changed)).toBe(false)
    const get = vi.fn((key: string) => key === changed.key ? changed : snapshot.nodes.get(key))
    index.update({ ...snapshot, nodes: { ...snapshot.nodes, get } }, [changed.key])
    expect(get.mock.calls.map(([key]) => key)).toEqual([changed.key])
    expect(index.layout).toBe(layout)
    for (const group of oldGroups.slice(0, -1)) expect(index.get(group.range.key)).toBe(group)
    expect(index.get(live.range.key)?.summary.runningDetail).toBe('Inspect current work in more detail')
    expect(index.get(live.range.key)).not.toBe(live)
  })

  it('regroups when a response begins and preserves preceding groups', () => {
    const fixture = history(2)
    const builder = new ChatSnapshotBuilder()
    const before = builder.replace({ nodes: fixture.nodes.values(), timeline: fixture.timeline })
    const historical = before.stepProcesses.layout.filter(range => range.process).map(range => before.stepProcesses.get(range.key)!)
    const live = historical.at(-1)!.nodes[0]!
    if (live.kind !== 'assistant-step') throw new Error('missing live assistant')
    const response: ChatNode<'assistant-step'> = {
      ...live, data: { ...live.data, blocks: [...live.data.blocks, { kind: 'text', text: 'Answer' }] },
    }
    expect(processLayoutChanged(live, response)).toBe(true)
    const after = builder.apply({ upserts: [response], timeline: fixture.timeline })
    for (const group of historical.slice(0, -1)) expect(after.stepProcesses.get(group.range.key)).toBe(group)
    expect(after.stepProcesses.get(historical.at(-1)!.range.key)?.range.closed).toBe(true)
    expect(after.stepProcesses.layout.at(-1)?.seats[0]?.assistantPart).toBe('response')
    const layout = after.stepProcesses.layout
    const updated = builder.apply({ upserts: [{ ...response, data: {
      ...response.data, blocks: [...live.data.blocks, { kind: 'text', text: 'Answer continued' }],
    } }], timeline: fixture.timeline })
    expect(updated.stepProcesses.layout).toBe(layout)
  })

  it('keeps unknown trailing turns live until their end is known', () => {
    const snapshot = history(0)
    const turn = snapshot.timeline.turns.get(1)!
    const index = new ChatStepProcessProjector()
    index.replace({ ...snapshot, timeline: {
      ...snapshot.timeline, turns: new Map([[1, { ...turn, status: 'unknown' }]]),
    } })
    const key = index.layout.find(range => range.process)!.key
    expect(index.get(key)?.range.closed).toBe(false)
    index.replace({ ...snapshot, timeline: {
      ...snapshot.timeline, turns: new Map([[1, { ...turn, status: 'closed' }]]),
    } })
    expect(index.get(key)?.range.closed).toBe(true)
  })

  it('drops groups and footer facts when the loaded window is replaced', () => {
    const populated = history(2)
    const index = new ChatStepProcessProjector()
    index.replace(populated)
    const key = index.layout.find(range => range.process)!.key
    index.replace(chatSnapshotFixture({ nodes: [] }))
    expect(index.layout).toEqual([])
    expect(index.get(key)).toBeUndefined()
    expect(index.footer(1)).toBeUndefined()
  })
})
