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
 *
 * Pending acknowledgements live for the signed-in lifecycle only. Signing out,
 * switching accounts, or unloading the plugin discards them, so a later sign-in
 * shows whatever the server still offers without restoring an earlier retry.
 * @module @deepseek-ai/dsh-client-ui-settings-account/src/client/bonus-notices
 */
import type {
  AccountBonusBatch, AccountBonusNotification, AccountBonusOrderId, AccountUserId,
} from '@deepseek-ai/dsh-deepseek-account/types'

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
   * previous account's notice and pending acknowledgements. The plugin calls this
   * for every signed-in account frame, so an account switch never leaves the
   * previous account's card or retries on screen.
   */
  begin(): void
  /** Stop the lifecycle, drop the displayed notice, and discard pending acknowledgement retries. */
  end(): void
  /**
   * Read the unnotified bonus once, for one Settings entry.
   * @returns after the read settles, so callers can await the whole entry.
   */
  refresh(): Promise<void>
  /** @param orderId - notice whose card passed a presented frame while visible. */
  shown(orderId: AccountBonusOrderId): void
  /** @param orderId - notice the user closed, which counts as seen. */
  dismiss(orderId: AccountBonusOrderId): void
}

/** Signed-in scope; the account and its pending acknowledgements appear once a read names them. */
interface NoticeScope {
  accountId?: AccountUserId
  /** Orders whose card was presented and whose acknowledgement has not settled, oldest first. */
  readonly pending: AccountBonusOrderId[]
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
  /** Orders the card on screen already reported, so one mount cannot acknowledge twice. */
  const reported = new Set<AccountBonusOrderId>()
  const clearAckTimer = (): void => { if (ackTimer !== undefined) { clearTimeout(ackTimer); ackTimer = undefined } }
  const setCurrent = (notice: BonusNotice | undefined): void => {
    if (notice === undefined && current === undefined) return
    if (notice?.orderId === current?.orderId && notice?.message === current?.message
      && notice?.expiresAt === current?.expiresAt) return
    // A different order means a different card, so its report is a fresh one.
    if (notice?.orderId !== current?.orderId) reported.clear()
    current = notice
    options.publish(notice ?? null)
  }
  const scheduleAck = (delay: number): void => {
    clearAckTimer()
    ackTimer = setTimeout(() => { void runAcks() }, delay)
  }
  /** Drop acknowledgement work of the previous account or lifecycle, so its carry-over cannot reach the next one. */
  const resetAcks = (): void => {
    clearAckTimer()
    ackInFlight = false
    ackDelay = options.ackRetryDelayMs
  }
  const startAcks = (): void => { if (scope !== undefined && scope.pending.length > 0) scheduleAck(0) }

  /**
   * Apply one read result. A notice already on screen stays until the user
   * closes it, and a re-offered order displays again once its card is gone.
   */
  const apply = (scopeAtRead: NoticeScope, batch: AccountBonusBatch): void => {
    if (scopeAtRead.accountId !== batch.accountId) {
      // A different account answered: the previous account's card and pending
      // acknowledgements belong to it and must not outlive its sign-in.
      scopeAtRead.accountId = batch.accountId
      scopeAtRead.pending.length = 0
      resetAcks()
      setCurrent(undefined)
    }
    const candidate: AccountBonusNotification | undefined = batch.bonuses[0]
    if (candidate === undefined) {
      // No candidate: a card the user has already seen stays until it is closed,
      // while a candidate that never reached a presented frame is withdrawn.
      if (current !== undefined && !reported.has(current.orderId)) setCurrent(undefined)
      return
    }
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
   * Acknowledge presented orders one at a time. A protocol failure backs off up
   * to the ceiling and retries for the rest of the signed-in lifecycle, which
   * never persists. A false answer settles the order without a retry: this
   * session cannot make the server accept it. A hidden window keeps retrying,
   * because the presented frame is what a pending acknowledgement proves.
   */
  async function runAcks(): Promise<void> {
    const scopeAtCall = scope
    if (scopeAtCall === undefined || ackInFlight) return
    const accountId = scopeAtCall.accountId
    const orderId = scopeAtCall.pending[0]
    if (accountId === undefined || orderId === undefined) return
    ackInFlight = true
    /** @returns whether this call still owns the lifecycle and account it started for. */
    const owns = (): boolean => scope === scopeAtCall && scopeAtCall.accountId === accountId
    let acknowledged: boolean
    try { acknowledged = await options.acknowledge(accountId, orderId) }
    catch {
      // The lifecycle ended or another account answered while the call was in flight:
      // its pending list, in-flight flag and timer now belong to the new owner.
      if (!owns()) return
      ackInFlight = false
      scheduleAck(ackDelay)
      ackDelay = Math.min(ackDelay * 2, options.ackRetryMaxDelayMs)
      return
    }
    if (!owns()) return
    ackInFlight = false
    // Success needs no record and a refusal has no retry, so either way this order
    // is settled for this lifecycle.
    if (scopeAtCall.pending[0] === orderId) scopeAtCall.pending.shift()
    ackDelay = options.ackRetryDelayMs
    if (acknowledged && scopeAtCall.pending.length > 0) scheduleAck(0)
    else clearAckTimer()
  }

  /** Queue a presented order, so an acknowledgement interrupted by a failure retries within this sign-in. */
  const report = (orderId: AccountBonusOrderId): void => {
    const scopeAtReport = scope
    if (scopeAtReport === undefined || current?.orderId !== orderId || reported.has(orderId)) return
    reported.add(orderId)
    if (!scopeAtReport.pending.includes(orderId)) scopeAtReport.pending.push(orderId)
    ackDelay = options.ackRetryDelayMs
    scheduleAck(0)
  }

  const endLifecycle = (): void => {
    if (scope === undefined) return
    readToken++
    resetAcks()
    scope = undefined
    reported.clear()
    setCurrent(undefined)
  }

  return {
    begin() {
      endLifecycle()
      scope = { pending: [] }
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
      report(orderId)
    },
    dismiss(orderId) {
      if (current?.orderId !== orderId) return
      // Closing the card is the user seeing it, so queue its acknowledgement before withdrawing.
      report(orderId)
      setCurrent(undefined)
    },
  }
}
