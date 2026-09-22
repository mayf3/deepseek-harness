/**
 * Lifecycle of bonus notices: one read at a time, one displayed notice at a
 * time, and acknowledgement of a notice only after its card reports a
 * presented frame. Reads happen when the account becomes active and when the
 * user asks for a refresh; the controller never polls.
 *
 * The server is the sole authority for which bonus is unnotified and owns the
 * copy, so this controller never synthesizes a notice from wallet balances and
 * never acknowledges an order the user did not see. Reads and acknowledgements
 * carry the UI locale so the server can localize its copy.
 * @module @deepseek-ai/dsh-client-ui-settings-account/src/client/bonus-notices
 */
import type {
  AccountBonusBatch, AccountBonusNotification, AccountBonusOrderId, AccountUserId,
} from '@deepseek-ai/dsh-deepseek-account/types'
import { bonusNoticeStorageKey, createBonusNoticeStore, type BonusNoticeStore } from './bonus-notice-store.ts'

/** Notice eligible for display; the message is server-authored for the active locale. */
export interface BonusNotice {
  /** Server order identity. */
  readonly orderId: AccountBonusOrderId
  /** Server-localized plain text, including any award amount or expiration. */
  readonly message: string
  /** Server expiration, re-checked at display time so a notice cannot appear after its award expired. */
  readonly expiresAt: string
}

/** Deployment-varying acknowledgement retry timings. */
export interface BonusNoticeTiming {
  /** Delay before the first acknowledgement retry, doubled per further failure. */
  readonly ackRetryDelayMs: number
  /** Ceiling for the acknowledgement retry backoff. */
  readonly ackRetryMaxDelayMs: number
}

/** Collaborators and timings of one bonus notice lifecycle. */
export interface BonusNoticeControllerOptions extends BonusNoticeTiming {
  /** Read the signed-in account's unnotified bonus. @returns the batch, or null when no account is signed in. */
  read: () => Promise<AccountBonusBatch | null>
  /**
   * Record one order as notified.
   * @param accountId - account the order belongs to.
   * @param orderId - shown order.
   * @returns false when the account changed or signed out; a protocol failure rejects.
   */
  acknowledge: (accountId: AccountUserId, orderId: AccountBonusOrderId) => Promise<boolean>
  /** @param notice - notice to display, or null when none is shown. */
  publish: (notice: BonusNotice | null) => void
}

/** Commands the account plugin issues to the bonus notice lifecycle. */
export interface BonusNoticeController {
  /**
   * Start the lifecycle for one signed-in account and read once, discarding any
   * previous account's notice. The plugin calls this for every signed-in account
   * frame, so an account switch never leaves the previous account's card on screen.
   * @param origin - Platform origin the local record is scoped to.
   */
  begin(origin: string): void
  /** Stop the lifecycle, drop the displayed notice, and cancel acknowledgement retries. */
  end(): void
  /**
   * Read the unnotified bonus once, for the user's explicit refresh.
   * @returns after the read settles, so callers can keep their own controls
   * disabled until the request is no longer in flight.
   */
  refresh(): Promise<void>
  /** @param orderId - notice whose card passed a presented frame while visible. */
  shown(orderId: AccountBonusOrderId): void
  /** @param orderId - notice the user closed, which counts as seen. */
  dismiss(orderId: AccountBonusOrderId): void
}

/** Signed-in scope; the account and its record appear once a read names them. */
interface NoticeScope {
  readonly origin: string
  accountId?: AccountUserId
  store?: BonusNoticeStore
}

/**
 * @param expiresAt - server expiration timestamp.
 * @param at - milliseconds since epoch.
 * @returns whether the bonus can no longer be shown.
 */
function expired(expiresAt: string, at: number): boolean {
  const expires = Date.parse(expiresAt)
  // An unparsable timestamp is not evidence of expiry, so the notice still shows.
  return !Number.isNaN(expires) && expires <= at
}

/**
 * Own the read, display, and acknowledgement lifecycle of bonus notices.
 * @param options - collaborators and timings.
 * @returns the controller the account plugin drives from account and settings state.
 */
export function createBonusNoticeController(options: BonusNoticeControllerOptions): BonusNoticeController {
  let scope: NoticeScope | undefined
  /** Notice currently published to the sidebar, including the expiration checked at display time. */
  let current: BonusNotice | undefined
  let readToken = 0
  let ackTimer: ReturnType<typeof setTimeout> | undefined
  let ackInFlight = false
  let ackDelay = options.ackRetryDelayMs
  const clearAckTimer = (): void => { if (ackTimer !== undefined) { clearTimeout(ackTimer); ackTimer = undefined } }
  const setCurrent = (notice: BonusNotice | undefined): void => {
    if (notice === undefined && current === undefined) return
    if (notice?.orderId === current?.orderId && notice?.message === current?.message
      && notice?.expiresAt === current?.expiresAt) return
    current = notice
    options.publish(notice ?? null)
  }
  const scheduleAck = (delay: number): void => {
    clearAckTimer()
    ackTimer = setTimeout(() => { void runAcks() }, delay)
  }
  const startAcks = (): void => { if (scope?.store !== undefined) scheduleAck(0) }

  /**
   * Apply one read result. A notice already on screen stays until the user
   * closes it; a candidate this account already recorded never returns.
   */
  const apply = (scopeAtRead: NoticeScope, batch: AccountBonusBatch): void => {
    if (scopeAtRead.accountId !== batch.accountId) {
      // A different account answered: its records, card, and pending
      // acknowledgements belong to it, and the previous account's card must not
      // stay on screen.
      scopeAtRead.accountId = batch.accountId
      scopeAtRead.store = createBonusNoticeStore(bonusNoticeStorageKey(scopeAtRead.origin, batch.accountId))
      setCurrent(undefined)
      startAcks()
    }
    const store = scopeAtRead.store
    const candidate: AccountBonusNotification | undefined = batch.bonuses[0]
    if (store === undefined) return
    if (candidate === undefined) {
      // No candidate: a card whose display was already recorded stays until the
      // user closes it, while a card that never reached a presented frame is a
      // stale candidate and is withdrawn.
      if (current !== undefined && store.state(current.orderId) === undefined) setCurrent(undefined)
      return
    }
    if (store.state(candidate.orderId) !== undefined) return
    if (candidate.orderId === current?.orderId) {
      // Same order still on screen: refresh its copy, and validate expiration at display time.
      setCurrent({ orderId: candidate.orderId, message: candidate.message, expiresAt: candidate.expiresAt })
      return
    }
    if (expired(candidate.expiresAt, Date.now())) return
    setCurrent({ orderId: candidate.orderId, message: candidate.message, expiresAt: candidate.expiresAt })
  }

  /** Read once; a result that arrives after the lifecycle or account changed is dropped. */
  async function runRead(): Promise<void> {
    const scopeAtRead = scope
    if (scopeAtRead === undefined) return
    const token = ++readToken
    let batch: AccountBonusBatch | null
    try { batch = await options.read() }
    catch {
      // A failed read reports nothing to the user; the next explicit read retries it.
      batch = null
    }
    if (scope !== scopeAtRead || token !== readToken) return
    if (batch !== null) apply(scopeAtRead, batch)
  }

  /**
   * Acknowledge one recorded order at a time. A protocol failure backs off up
   * to the ceiling; a false answer means this session no longer owns the
   * account, so the record stays pending and the next sign-in retries it.
   * A pending record already proves the card was presented, so a hidden window
   * keeps retrying: finishing the acknowledgement is what stops another device
   * from showing the same award.
   */
  async function runAcks(): Promise<void> {
    const scopeAtCall = scope
    if (scopeAtCall === undefined || ackInFlight) return
    const store = scopeAtCall.store
    const accountId = scopeAtCall.accountId
    const orderId = store?.pending()[0]
    if (store === undefined || accountId === undefined || orderId === undefined) return
    ackInFlight = true
    let acknowledged: boolean
    try { acknowledged = await options.acknowledge(accountId, orderId) }
    catch {
      ackInFlight = false
      if (scope !== scopeAtCall) { startAcks(); return }
      scheduleAck(ackDelay)
      ackDelay = Math.min(ackDelay * 2, options.ackRetryMaxDelayMs)
      return
    }
    ackInFlight = false
    if (scope !== scopeAtCall) { startAcks(); return }
    if (!acknowledged) return
    store.write(orderId, 'acknowledged')
    ackDelay = options.ackRetryDelayMs
    scheduleAck(0)
  }

  /** Record a shown order before acknowledging it, so an interruption between the two still retries. */
  const record = (orderId: AccountBonusOrderId): void => {
    const store = scope?.store
    if (store === undefined || current?.orderId !== orderId) return
    if (store.state(orderId) === undefined) store.write(orderId, 'pending')
    ackDelay = options.ackRetryDelayMs
    scheduleAck(0)
  }

  const endLifecycle = (): void => {
    if (scope === undefined) return
    clearAckTimer()
    readToken++
    scope = undefined
    setCurrent(undefined)
  }

  return {
    begin(origin) {
      endLifecycle()
      scope = { origin }
      void runRead()
    },
    end: endLifecycle,
    refresh(): Promise<void> {
      if (scope === undefined) return Promise.resolve()
      startAcks()
      return runRead()
    },
    shown(orderId) {
      if (current?.orderId !== orderId) return
      if (expired(current.expiresAt, Date.now())) return
      record(orderId)
    },
    dismiss(orderId) {
      if (current?.orderId !== orderId) return
      // Closing the card is the user seeing it, so record before withdrawing.
      record(orderId)
      setCurrent(undefined)
    },
  }
}
