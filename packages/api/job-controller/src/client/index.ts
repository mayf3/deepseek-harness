/**
 * Job Controller client half: installs `ctx.jobOutput` over the generated
 * `job` Remote namespace. The plugin resolves both Remote faces it drives
 * while its own context is current, because observation (re)opens run on
 * caller stacks — a React event, a carrier retry — whose dynamic context has
 * not declared `remote.job`.
 * @module @deepseek-ai/dsh-api-job-controller/client
 */

import type { Context } from '@deepseek-ai/cordis'
import { ClientJobOutputModel } from './model.ts'
import { ClientJobOutput } from './service.ts'
import type { JobObserveRemote } from './service.ts'

export { ClientJobOutputModel } from './model.ts'
export type { JobOutputSnapshot, JobOutputSource, ObservedJob } from './model.ts'
export { ClientJobOutput } from './service.ts'
export type { IJobOutput, JobObserveRemote, JobRemote } from './service.ts'
export type { JobObserveFrame, JobObserveRequest, JobObserveStatus, JobWireChunk } from '../types.ts'

/** Required Client Remote services. */
export const inject = ['remote', 'remote.job']

/**
 * Install the client job-output service.
 * @param ctx - Client root Context.
 */
export function apply(ctx: Context): void {
  const remotes = ctx.remote as unknown as JobObserveRemote
  new ClientJobOutput(ctx, {
    $stream: options => remotes.$stream(options),
    job: remotes.job,
  }, new ClientJobOutputModel())
}
