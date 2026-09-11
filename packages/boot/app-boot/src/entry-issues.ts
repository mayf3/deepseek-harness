/** Entry-owned load/update failures and missing services, independent of bundle grouping. */
import type { Context, FiberState } from '@deepseek-ai/cordis'
import type { Entry } from '@deepseek-ai/cordis-plugin-loader'

const PENDING = 0 as FiberState.PENDING
const ACTIVE = 2 as FiberState.ACTIVE
const FAILED = 3 as FiberState.FAILED

/** A failed attempt or unresolved dependency of one configured entry. */
export interface EntryIssue {
  /** Entry whose options and fiber describe the requested and running configuration. */
  readonly entry: Entry
  readonly stage: 'import' | 'activation' | 'update' | 'disabled-expression' | 'inject-pending'
  readonly message: string
  /** Original rejection, retained only in process for duplicate rejection handling. */
  readonly error?: unknown
}

const observedRejections = new Map<unknown, number>()

/**
 * Whether a rejection is already being reported by an entry audit.
 * @param reason - the process rejection reason.
 * @returns true during the audit's rejection checkpoint.
 */
export function isObservedEntryRejection(reason: unknown): boolean {
  return observedRejections.has(reason)
}

/**
 * Render nested causes and aggregate members without cycling or dropping plugin stacks.
 * @param error - the thrown value.
 * @returns the diagnostic text.
 */
export function formatEntryError(error: unknown): string {
  const details: string[] = []
  const seen = new Set<Error>()
  const visit = (value: unknown): void => {
    if (!(value instanceof Error)) {
      details.push(String(value))
      return
    }
    if (seen.has(value)) return
    seen.add(value)
    details.push(value.stack ?? value.message)
    if (value.cause !== undefined) visit(value.cause)
    if (value instanceof AggregateError) value.errors.forEach(visit)
  }
  visit(error)
  return details.join('\n')
}

/**
 * Read one entry's latest failed attempt or unresolved services without activating it.
 * @param entry - the current Loader entry.
 * @returns its issue, or undefined when disabled or active without a failed update.
 */
export async function entryIssue(entry: Entry): Promise<EntryIssue | undefined> {
  try {
    if (entry.disabled) return undefined
  } catch (error) {
    return { entry, stage: 'disabled-expression', message: formatEntryError(error), error }
  }
  if (entry.lastFailure !== undefined) {
    const { stage, error } = entry.lastFailure
    return { entry, stage, message: `${stage === 'import' ? 'failed to import: ' : ''}${formatEntryError(error)}`, error }
  }
  const fiber = entry.fiber
  if (fiber === undefined) return { entry, stage: 'import', message: 'failed to import' }
  if (fiber.state === ACTIVE) return undefined
  if (fiber.state === FAILED) {
    try {
      await fiber.await()
    } catch (error) {
      return { entry, stage: 'activation', message: formatEntryError(error), error }
    }
    return undefined
  }
  if (fiber.state === PENDING) {
    const missing = Object.keys(fiber.inject).filter(service => fiber.ctx.get(service) === undefined)
    return {
      entry, stage: 'inject-pending',
      message: `pending (waiting for ${missing.length === 1 ? 'service' : 'services'}: ${missing.join(', ') || 'unknown'})`,
    }
  }
  return { entry, stage: 'activation', message: `fiber state ${String(fiber.state)}` }
}

/**
 * Collect current entry issues and coalesce Loader's duplicate process rejections.
 * @param ctx - the context owning the Loader.
 * @returns current issues; no historical failure registry is retained.
 */
export async function inspectEntryIssues(ctx: Context): Promise<EntryIssue[]> {
  const issues: EntryIssue[] = []
  for (const entry of ctx.loader.entries()) {
    const issue = await entryIssue(entry)
    if (issue !== undefined) issues.push(issue)
  }
  const reasons = issues.filter(issue => 'error' in issue).map(issue => issue.error)
  if (reasons.length > 0) {
    for (const reason of reasons) observedRejections.set(reason, (observedRejections.get(reason) ?? 0) + 1)
    try {
      await new Promise<void>(resolve => setImmediate(resolve))
    } finally {
      for (const reason of reasons) {
        const count = observedRejections.get(reason)
        if (count !== undefined && count > 1) observedRejections.set(reason, count - 1)
        else observedRejections.delete(reason)
      }
    }
  }
  return issues
}
