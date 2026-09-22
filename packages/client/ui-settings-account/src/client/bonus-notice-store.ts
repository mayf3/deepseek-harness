/**
 * Local record of bonus notices the user has actually seen, scoped to one
 * Platform origin and account. A notice is written before its server
 * acknowledgement is attempted, so an interruption between the two leaves a
 * retryable record instead of a notice that is shown again.
 *
 * When the browser denies storage, the record falls back to a module-level map
 * so signing out and back in during one page load still does not repeat a
 * notice. That fallback does not survive a reload, which is the best available
 * behavior without storage.
 * @module @deepseek-ai/dsh-client-ui-settings-account/src/client/bonus-notice-store
 */
import type { AccountBonusOrderId, AccountUserId } from '@deepseek-ai/dsh-deepseek-account/types'

/** Whether a shown notice still awaits server acknowledgement. */
export type BonusNoticeAckState = 'pending' | 'acknowledged'

/** Local record of shown bonus notices for one Platform origin and account. */
export interface BonusNoticeStore {
  /** @param orderId - notice to look up. @returns its recorded state, or undefined when it was never shown. */
  state(orderId: AccountBonusOrderId): BonusNoticeAckState | undefined
  /** @returns order ids still awaiting server acknowledgement, oldest written first. */
  pending(): readonly AccountBonusOrderId[]
  /** @param orderId - shown notice. @param state - acknowledgement state to record. */
  write(orderId: AccountBonusOrderId, state: BonusNoticeAckState): void
}

/** Records of a page whose browser storage is unavailable. */
const memoryRecords = new Map<string, Map<AccountBonusOrderId, BonusNoticeAckState>>()

/**
 * Storage key for one Platform origin and account.
 * @param origin - Platform origin the account belongs to.
 * @param accountId - Platform account.
 * @returns the record key.
 */
export function bonusNoticeStorageKey(origin: string, accountId: AccountUserId): string {
  return `dsh-account-bonus:${origin}:${accountId}`
}

/** @returns browser storage, or undefined when the context denies access to it. */
function browserStorage(): Storage | undefined {
  try { return globalThis.localStorage }
  catch {
    // Private and embedded contexts can deny the property itself.
    return undefined
  }
}

/** @param raw - stored text. @returns the recorded states of a well-formed record; an unusable record reads as empty. */
function parseRecords(raw: string): Map<AccountBonusOrderId, BonusNoticeAckState> {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // A record this module did not write is not usable; the next write replaces it.
    return new Map()
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return new Map()
  const records = new Map<AccountBonusOrderId, BonusNoticeAckState>()
  for (const [orderId, state] of Object.entries(parsed as Record<string, unknown>)) {
    if (orderId === '') continue
    if (state === 'pending' || state === 'acknowledged') records.set(orderId as AccountBonusOrderId, state)
  }
  return records
}

/**
 * Open the record for one Platform origin and account.
 * @param key - storage key from {@link bonusNoticeStorageKey}.
 * @returns the record, backed by browser storage when it is available.
 */
export function createBonusNoticeStore(key: string): BonusNoticeStore {
  // A page fallback outranks storage: it exists only because a write could not
  // reach storage, and the stored copy is then the older one.
  const fallback = memoryRecords.get(key)
  const backing = fallback === undefined ? readBacking(key) : undefined
  const records = fallback ?? backing?.records ?? new Map<AccountBonusOrderId, BonusNoticeAckState>()
  if (backing === undefined) memoryRecords.set(key, records)
  return {
    state: orderId => records.get(orderId),
    pending: () => [...records].filter(([, state]) => state === 'pending').map(([orderId]) => orderId),
    write(orderId, state) {
      records.set(orderId, state)
      if (backing === undefined) return
      try {
        backing.storage.setItem(key, JSON.stringify(Object.fromEntries(records)))
        // Storage now holds the record, so drop a fallback left by an earlier failure.
        memoryRecords.delete(key)
      }
      catch {
        // Persistence can be denied or full. Keeping this page's records makes
        // the next open of this key prefer them over the stale stored copy.
        memoryRecords.set(key, records)
      }
    },
  }
}

/** @param key - record key. @returns browser storage with its current records, or undefined when storage is denied. */
function readBacking(key: string): { storage: Storage; records: Map<AccountBonusOrderId, BonusNoticeAckState> } | undefined {
  const storage = browserStorage()
  if (storage === undefined) return undefined
  try {
    const raw = storage.getItem(key)
    return { storage, records: raw === null ? new Map<AccountBonusOrderId, BonusNoticeAckState>() : parseRecords(raw) }
  } catch {
    // A denied read takes the page fallback, like a denied property.
    return undefined
  }
}
