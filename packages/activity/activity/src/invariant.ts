/** Package-owned process-snapshot invariants. @module @deepseek-ai/dsh-activity/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { ActivitySnapshot } from './types.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-activity'
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'killed'])

/** Cordis companion plugin name. */
export const name = 'activity-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Validate the cross-field relationships in one registry snapshot. */
/* jscpd:ignore-start -- mirrors the jobs invariant's id/ordinal checks by design; the two registries share the `<kind>-N` scheme. */
function validateSnapshot(snapshot: ActivitySnapshot, fail: InvariantFailure): void {
  const id = String(snapshot.id)
  const prefix = `${snapshot.kind}-`
  const ordinal = Number(id.slice(prefix.length))
  if (snapshot.kind.length === 0 || !id.startsWith(prefix)
    || !Number.isSafeInteger(ordinal) || ordinal < 1) {
    fail(`activity snapshot id ${JSON.stringify(id)} must be ${JSON.stringify(prefix)} followed by a positive ordinal`)
  }
  if (snapshot.label.length === 0) fail(`activity ${JSON.stringify(id)} label must be non-empty`)
  if (!Number.isSafeInteger(snapshot.startedAt) || snapshot.startedAt < 0) {
    fail(`activity ${JSON.stringify(id)} startedAt must be a non-negative epoch integer`)
  }
  /* jscpd:ignore-end */

  const terminal = TERMINAL_STATUSES.has(snapshot.status)
  if (terminal !== (snapshot.finishedAt !== undefined)) {
    fail(`activity ${JSON.stringify(id)} finishedAt must be present exactly for a terminal status`)
  }
  if (snapshot.finishedAt !== undefined
    && (!Number.isSafeInteger(snapshot.finishedAt) || snapshot.finishedAt < snapshot.startedAt)) {
    fail(`activity ${JSON.stringify(id)} finishedAt must be an epoch integer no earlier than startedAt`)
  }

  if (!Number.isSafeInteger(snapshot.outputTotal) || snapshot.outputTotal < 0
    || !Number.isSafeInteger(snapshot.outputEarliest) || snapshot.outputEarliest < 0
    || snapshot.outputEarliest > snapshot.outputTotal) {
    fail(`activity ${JSON.stringify(id)} output offsets must satisfy 0 <= outputEarliest <= outputTotal`)
  }
}

/** Install checks over current visible records and every later visible-set change. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  for (const snapshot of ctx.activities.list()) validateSnapshot(snapshot, fail)
  ctx.activities.onActivitiesChanged((owner: Agent | undefined) => {
    for (const snapshot of ctx.activities.list(owner)) validateSnapshot(snapshot, fail)
  })
}, { inject: ['activities'] })

/**
 * Register the process-registry invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
