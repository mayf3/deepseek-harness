import { describe, expect, it } from 'vitest'
import type { ChatNode } from '../src/client/contract/chat-nodes.ts'
import { processActivity } from '../src/client/chat/step-process.ts'
import { chatSnapshotFixture } from './chat-snapshot-fixture.client.ts'
import type { RunningToolCall } from '../src/client/contract/snapshot.ts'

function call(callId: string, name: string, file = callId): RunningToolCall {
  return { callId, name, argsRaw: JSON.stringify({ file_path: file }), turn: 1, step: 1, time: 1, subCalls: [] }
}

function nodes(calls: readonly RunningToolCall[]): ChatNode[] {
  return chatSnapshotFixture({ runningCalls: calls }).nodes.values() as ChatNode[]
}

describe('process activity summary', () => {
  it('ranks only the largest three categories and deduplicates files and recursive call ids', () => {
    const read = call('r1', 'read', '/a')
    const calls = [read, call('r2', 'read', '/a'), call('r3', 'read', '/b'),
      call('e1', 'edit'), call('e2', 'write'), call('e3', 'edit'),
      call('b1', 'bash'), call('b2', 'pwsh'), call('b3', 'bash'), call('b4', 'bash'),
      call('s', 'grep'), { ...call('code', 'run_code'), subCalls: [read] }]
    expect(processActivity(nodes(calls)).counts).toEqual([
      { kind: 'commands', count: 4 }, { kind: 'edit', count: 3 }, { kind: 'read', count: 2 },
    ])
  })

  it('keeps incomplete streamed arguments usable and reports nested running work', () => {
    const root = { ...call('code', 'run_code'), subCalls: [{ ...call('read', 'read'), argsRaw: '{' }] }
    expect(processActivity(nodes([root]))).toMatchObject({
      running: 'read', counts: [{ kind: 'tools', count: 1 }, { kind: 'read', count: 1 }],
    })
  })
})
