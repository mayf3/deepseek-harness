import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { TeamError, TeamTaskId, type TeamTaskView } from '@deepseek-ai/dsh-team'
import AgentTeamRemoteService from '../src/index.ts'

const agent = { id: 'lead' } as Agent
const task: TeamTaskView = {
  id: TeamTaskId('task-1'),
  revision: 1,
  subject: 'Task',
  description: 'Description',
  status: 'pending',
  blockedBy: [],
  writeScopes: [],
  ready: true,
  writeScopeWarnings: [],
}

function bench() {
  const ctx = new Context()
  const teams = {
    listMembers: vi.fn(() => [{
      id: agent.id, name: 'lead', role: 'lead' as const, status: 'idle' as const, diagnostics: [],
    }]),
    listTasks: vi.fn(() => [task]),
    createTask: vi.fn(() => Promise.resolve(task)),
    updateTask: vi.fn(() => Promise.resolve({ ...task, revision: 2 })),
  }
  ctx.provide('teams', teams as never)
  const adapter = new AgentTeamRemoteService(ctx)
  return { ctx, teams, adapter }
}

describe('Agent Teams Remote adapter', () => {
  it('owns only the browser adapter service and delegates state operations to ctx.teams', async () => {
    const { ctx, teams, adapter } = bench()
    expect(ctx.teamRemote).toBeInstanceOf(AgentTeamRemoteService)
    expect(ctx.teamRemote).not.toBe(ctx.teams)
    expect(ctx.teams).toMatchObject(teams)
    expect(adapter.typertRemote).toMatchObject({ serviceKey: 'teamRemote', namespace: 'teams' })
    expect(adapter.view(agent)).toEqual({
      members: [{ id: agent.id, name: 'lead', role: 'lead', status: 'idle', diagnostics: [] }],
      tasks: [task],
    })
    expect(teams.listMembers).toHaveBeenCalledWith(agent)
    expect(teams.listTasks).toHaveBeenCalledWith(agent)
    await expect(adapter.createTask(agent, {
      subject: 'Task', description: 'Description',
    })).resolves.toEqual(task)
    await expect(adapter.createTask(agent, {
      subject: 'Blocked task',
      description: 'Description',
      blockedBy: ['task-0'],
      writeScopes: ['src/team'],
    })).resolves.toEqual(task)
    expect(teams.createTask).toHaveBeenLastCalledWith(agent, {
      subject: 'Blocked task',
      description: 'Description',
      blockedBy: ['task-0'],
      writeScopes: ['src/team'],
    })
    await expect(adapter.updateTask(agent, {
      taskId: task.id, expectedRevision: 1, action: 'claim',
    })).resolves.toMatchObject({ ok: true, value: { revision: 2 } })
    await expect(adapter.updateTask(agent, {
      taskId: task.id,
      expectedRevision: 2,
      action: 'edit',
      subject: 'Edited',
      description: 'Edited description',
      blockedBy: ['task-0'],
      writeScopes: ['src/team'],
      owner: 'worker',
    })).resolves.toMatchObject({ ok: true, value: { revision: 2 } })
    expect(teams.updateTask).toHaveBeenLastCalledWith(agent, {
      taskId: task.id,
      expectedRevision: 2,
      action: 'edit',
      subject: 'Edited',
      description: 'Edited description',
      blockedBy: ['task-0'],
      writeScopes: ['src/team'],
      owner: 'worker',
    })
  })

  it('maps Team task failures and preserves unexpected rejections', async () => {
    const { teams, adapter } = bench()
    teams.updateTask
      .mockRejectedValueOnce(new TeamError('stale', 'TEAM_TASK_STALE_REVISION'))
      .mockRejectedValueOnce(new TeamError('denied', 'TEAM_TASK_FORBIDDEN'))
      .mockRejectedValueOnce(new Error('unexpected mutation failure'))
    const request = { taskId: task.id, expectedRevision: 1, action: 'delete' as const }
    await expect(adapter.updateTask(agent, request)).resolves.toEqual({
      ok: false, error: { code: 'team-task-conflict', message: 'stale' },
    })
    await expect(adapter.updateTask(agent, request)).resolves.toEqual({
      ok: false, error: { code: 'team-rejected', message: 'denied' },
    })
    await expect(adapter.updateTask(agent, request)).rejects.toThrow('unexpected mutation failure')
  })
})
