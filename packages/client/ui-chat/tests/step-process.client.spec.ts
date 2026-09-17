import { describe, expect, it } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ChatNode } from '../src/client/contract/chat-nodes.ts'
import { processActivity, processRanges, processTitle } from '../src/client/chat/step-process.ts'
import { en, zh } from '../src/client/locale.ts'
import { chatSnapshotFixture } from './chat-snapshot-fixture.client.ts'
import type { ModelRetryNode, RunningToolCall } from '../src/client/contract/snapshot.ts'

function call(callId: string, name: string, file = callId): RunningToolCall {
  return { callId, name, argsRaw: JSON.stringify({ file_path: file }), turn: 1, step: 1, time: 1, subCalls: [] }
}

function nodes(calls: readonly RunningToolCall[]): ChatNode[] {
  return calls.flatMap(value => chatSnapshotFixture({ runningCalls: [value] }).nodes.values() as ChatNode[])
}

function titles(names: string[], closed = true): string[] {
  const summary = processActivity(nodes(names.map((name, i) => call(String(i), name))))
  return [zh, en].map(dictionary => processTitle(summary, closed, makeTranslate(dictionary)))
}

function retry(retryState: ModelRetryNode['retryState']): ModelRetryNode {
  return { kind: 'model-retry', seq: 2, time: 2, retryId: 'retry' as ModelRetryNode['retryId'], turn: 1, step: 1,
    provider: 'mock', mode: 'always', policyKey: 'demo', retry: 1, delayMs: 1000,
    failure: { message: 'rate limit', code: 'RATE_LIMIT' }, retryState }
}

describe('process activity summary', () => {
  it('counts repeated paths as calls, deduplicates recursive ids and preserves ties in first-seen order', () => {
    const read = call('r1', 'read', '/a')
    const calls = [read, call('r2', 'read', '/a'), call('r3', 'read', '/b'),
      call('e1', 'edit'), call('e2', 'write'), call('e3', 'edit'),
      call('b1', 'bash'), call('b2', 'pwsh'), call('b3', 'bash'), call('b4', 'bash'),
      call('s', 'grep'), { ...call('code', 'run_code'), subCalls: [read] }]
    expect(processActivity(nodes(calls)).counts).toEqual([
      { kind: 'commands', count: 4 }, { kind: 'read', count: 3 }, { kind: 'edit', count: 3 },
      { kind: 'search', count: 1 }, { kind: 'code', count: 1 },
    ])
  })

  it('reports the newest running nested call even when an older root is visited later', () => {
    const root = { ...call('code', 'run_code'), subCalls: [{ ...call('read', 'read'), time: 3, argsRaw: '{' }] }
    const summary = processActivity(nodes([root, { ...call('bash', 'bash'), time: 2 }]))
    expect(summary.running).toBe('read')
    expect(summary.runningDetail).toBe('')
  })

  it.each([
    [['read', 'read_image', 'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'], '正在读取文件', 'Reading files'],
    [['grep', 'glob', 'session_inspect'], '正在搜索代码', 'Searching code'],
    [['write', 'edit', 'apply_patch'], '正在编辑文件', 'Editing files'],
    [['bash', 'pwsh', 'exec_command', 'write_stdin', 'terminal_read'], '正在运行命令', 'Running commands'],
    [['run_code'], '正在运行代码', 'Running code'],
    [['web_search'], '正在搜索网页', 'Searching the web'],
    [['web_fetch'], '正在访问网页', 'Visiting web pages'],
    [['subagent', 'subagent_custom'], '正在协调子任务', 'Coordinating subagents'],
    [['todo_write', 'create_goal', 'update_goal', 'get_goal'], '正在更新计划', 'Updating the plan'],
    [['ask_user_question', 'request_user_input'], '等待你的操作', 'Waiting for your action'],
    [['job_output', 'job_list', 'job_kill', 'send_message', 'list_agents', 'custom'], '正在调用工具', 'Calling tools'],
  ])('classifies %j with abstract live copy', (names, chinese, english) => {
    for (const name of names) expect(titles([name], false)).toEqual([chinese, english])
  })

  it.each([
    [['read'], '已读取文件', 'Read files'],
    [['web_search', 'todo_write'], '已搜索网页并更新了计划', 'Searched the web and updated the plan'],
    [['edit', 'bash'], '修改了文件并执行了命令', 'Edited files and ran commands'],
    [['read', 'grep', 'edit'], '已读取文件，已搜索代码，修改了文件', 'Read files, searched code, edited files'],
    [['read', 'grep', 'edit', 'bash'], '已读取文件，已搜索代码，修改了文件等', 'Read files, searched code, edited files, etc.'],
    [['read', 'grep'], '已读取文件并搜索代码', 'Read files and searched code'],
    [['read', 'edit'], '已读取文件并修改了文件', 'Read files and edited files'],
    [['edit', 'grep'], '修改了文件并已搜索代码', 'Edited files and searched code'],
    [['read', 'grep', 'bash'], '已读取文件，已搜索代码，执行了命令', 'Read files, searched code, ran commands'],
    [['read', 'grep', 'bash', 'edit'], '已读取文件，已搜索代码，执行了命令等', 'Read files, searched code, ran commands, etc.'],
    [['read', 'grep', 'bash', 'edit', 'edit'], '修改了文件，已读取文件，已搜索代码等', 'Edited files, read files, searched code, etc.'],
    [['run_code', 'web_search'], '运行了代码并已搜索网页', 'Ran code and searched the web'],
    [['web_fetch', 'subagent'], '已访问网页并协调子任务', 'Visited web pages and coordinated subagents'],
    [['todo_write', 'ask_user_question', 'job_list'], '更新了计划，向用户提出了问题，已调用工具', 'Updated the plan, asked questions, called tools'],
  ])('formats completed categories %j without counts', (names, chinese, english) => {
    expect(titles(names)).toEqual([chinese, english])
  })

  it('keeps retry rows independent of secondary process groups in every phase', () => {
    expect(titles([], false)).toEqual(['正在分析请求', 'Analyzing the request'])
    expect(titles([])).toEqual(['已完成分析', 'Analysis completed'])
    for (const state of ['scheduled', 'started', 'cancelled'] as const) {
      const snapshot = chatSnapshotFixture({ nodes: [retry(state)] })
      const ranges = processRanges(snapshot)
      const retryRange = ranges.find(range => range.seats.some(seat => snapshot.nodes.get(seat.nodeKey)?.kind === 'model-retry'))!
      expect(retryRange.process).toBe(false)
      expect(retryRange.seats).toHaveLength(1)
    }
  })

  it('closes process work when reply text starts while the turn remains open', () => {
    const before = chatSnapshotFixture({ nodes: [retry('started')], partial: {
      turn: 1, step: 1, blocks: [{ kind: 'reasoning', text: 'analysis' }],
    } })
    expect(processRanges(before).filter(range => range.process).at(-1)?.closed).toBe(false)
    const after = chatSnapshotFixture({ nodes: [retry('started')], partial: {
      turn: 1, step: 1, blocks: [{ kind: 'reasoning', text: 'analysis' }, { kind: 'text', text: 'Reply begins' }],
    } })
    expect(after.timeline.turns.get(1)?.status).toBe('open')
    expect(processRanges(after).filter(range => range.process).every(range => range.closed)).toBe(true)
  })
})
