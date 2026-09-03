/** Package-owned background-job projection invariants. @module @deepseek-ai/dsh-jobs/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { JobView } from './types.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-jobs'
const TERMINAL_STATUSES = new Set(['completed', 'killed', 'failed'])

/** Cordis companion plugin name. */
export const name = 'jobs-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Validate the cross-field relationships in one registry projection. */
function validateView(job: JobView, fail: InvariantFailure): void {
  const id = String(job.id)
  const prefix = `${job.kind}-`
  const ordinal = Number(id.slice(prefix.length))
  if (job.kind.length === 0 || !id.startsWith(prefix)
    || !Number.isSafeInteger(ordinal) || ordinal < 1) {
    fail(`job view id ${JSON.stringify(id)} must be ${JSON.stringify(prefix)} followed by a positive ordinal`)
  }
  if (job.label.length === 0) fail(`job ${JSON.stringify(id)} label must be non-empty`)
  if (!Number.isSafeInteger(job.startedAt) || job.startedAt < 0) {
    fail(`job ${JSON.stringify(id)} startedAt must be a non-negative epoch integer`)
  }

  const terminal = TERMINAL_STATUSES.has(job.status)
  if (terminal !== (job.finishedAt !== undefined)) {
    fail(`job ${JSON.stringify(id)} finishedAt must be present exactly for a terminal status`)
  }
  if (job.finishedAt !== undefined
    && (!Number.isSafeInteger(job.finishedAt) || job.finishedAt < job.startedAt)) {
    fail(`job ${JSON.stringify(id)} finishedAt must be an epoch integer no earlier than startedAt`)
  }
  if (terminal && job.progress !== undefined) {
    fail(`job ${JSON.stringify(id)} progress must be cleared once settled`)
  }

  const { total, earliest } = job.output
  if (!Number.isSafeInteger(total) || !Number.isSafeInteger(earliest) || earliest < 0 || earliest > total) {
    fail(`job ${JSON.stringify(id)} output offsets must satisfy 0 <= earliest <= total`)
  }
}

/** Install checks over the current unowned projections and every settlement. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  for (const job of ctx.jobs.visibleTo().list()) validateView(job, fail)
  ctx.jobs.events.subscribe({ owners: 'all' }, (event) => {
    if (event.type === 'settled') validateView(event.job, fail)
  })
}, { inject: ['jobs'] })

/**
 * Register the job-registry invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
