/**
 * Job Controller client half: installs `ctx.jobs` over the generated `job`
 * Remote namespace. The plugin resolves both Remote faces it drives while its
 * own context is current, because stream (re)opens run on caller stacks — a
 * React event, a carrier retry — whose dynamic context has not declared
 * `remote.job`.
 * @module @deepseek-ai/dsh-api-job-controller/client
 */

import type { Context } from '@deepseek-ai/cordis'
import { ClientJobsModel } from './model.ts'
import { ClientJobs } from './service.ts'
import type { JobsRemote } from './service.ts'

export type { JobsSnapshot, ObservedJob } from './model.ts'
// The `ctx.jobs` contract. Its module also carries the Context augmentation
// that declares `ctx.jobs`, which reaches consumers only through this export:
// declaration emit drops the value import above.
export type { IJobs } from './service.ts'
export type {
  JobChunk, JobObserveFrame, JobObserveRequest, JobRowsFrame, JobRowsRequest, JobView,
} from '../types.ts'

/** Required Client Remote services. */
export const inject = ['remote', 'remote.job']

/**
 * Install the client jobs service.
 * @param ctx - Client root Context.
 */
export function apply(ctx: Context): void {
  const remotes = ctx.remote as unknown as JobsRemote
  new ClientJobs(ctx, {
    $stream: options => remotes.$stream(options),
    job: remotes.job,
  }, new ClientJobsModel())
}
