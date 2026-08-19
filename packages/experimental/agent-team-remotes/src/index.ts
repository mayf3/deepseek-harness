/** Browser-facing Remote adapter over the Agent Teams domain service. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { TeamError, TeamTaskId } from '@deepseek-ai/dsh-team'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {
  CreateTeamTaskRequest,
  TeamTaskMutationResult,
  TeamTaskView,
  TeamView,
  UpdateTeamTaskRequest,
} from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    teamRemote: AgentTeamRemoteService
  }
}

/** Stateless browser projection and command adapter for `ctx.teams`. */
export class AgentTeamRemoteService extends TypertRemoteService {
  static inject = ['teams']

  /**
   * @param ctx - Host context carrying the Agent Teams domain service.
   */
  constructor(ctx: Context) {
    super(ctx, 'teamRemote', { namespace: 'teams' })
  }

  /**
   * Read the current roster and non-deleted task board.
   * @param agent - exact live Team member used as the authority credential.
   * @returns detached current roster and task views.
   */
  @Remote('view')
  view(agent: Agent): TeamView {
    return {
      members: this.ctx.teams.listMembers(agent),
      tasks: this.ctx.teams.listTasks(agent),
    }
  }

  /**
   * Create one shared task.
   * @param agent - exact live Team member creating the task.
   * @param request - task text, blockers, and advisory write scopes.
   * @returns the revision-one task view.
   */
  @Remote('createTask')
  createTask(agent: Agent, request: CreateTeamTaskRequest): Promise<TeamTaskView> {
    return this.ctx.teams.createTask(agent, {
      subject: request.subject,
      description: request.description,
      ...(request.blockedBy === undefined ? {} : { blockedBy: request.blockedBy.map(TeamTaskId) }),
      ...(request.writeScopes === undefined ? {} : { writeScopes: request.writeScopes }),
    })
  }

  /**
   * Apply one task mutation while preserving CAS conflicts as business results.
   * @param agent - exact live Team member authorizing the mutation.
   * @param request - task identity, expected revision, action, and action fields.
   * @returns the committed task or a browser-safe Team rejection.
   */
  @Remote('updateTask')
  async updateTask(agent: Agent, request: UpdateTeamTaskRequest): Promise<TeamTaskMutationResult> {
    try {
      return {
        ok: true,
        value: await this.ctx.teams.updateTask(agent, {
          taskId: TeamTaskId(request.taskId),
          expectedRevision: request.expectedRevision,
          action: request.action,
          ...(request.subject === undefined ? {} : { subject: request.subject }),
          ...(request.description === undefined ? {} : { description: request.description }),
          ...(request.blockedBy === undefined ? {} : { blockedBy: request.blockedBy.map(TeamTaskId) }),
          ...(request.writeScopes === undefined ? {} : { writeScopes: request.writeScopes }),
          ...(request.owner === undefined ? {} : { owner: request.owner }),
        }),
      }
    } catch (error) {
      if (!(error instanceof TeamError)) throw error
      return {
        ok: false,
        error: {
          code: error.code === 'TEAM_TASK_STALE_REVISION' ? 'team-task-conflict' : 'team-rejected',
          message: error.message,
        },
      }
    }
  }
}

export default AgentTeamRemoteService
