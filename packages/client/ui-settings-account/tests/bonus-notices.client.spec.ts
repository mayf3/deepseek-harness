// @vitest-environment jsdom
/**
 * Bonus notice lifecycle: reads happen when the account becomes active and on
 * an explicit refresh, never on a timer. A notice is acknowledged only after its
 * card reports a presented frame, with backoff retry for the rest of the
 * signed-in lifecycle; nothing about a notice survives sign-out or unload.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AccountBonusBatch, AccountBonusOrderId, AccountUserId } from '@deepseek-ai/dsh-deepseek-account/types'
import { createBonusNoticeController, type BonusNotice } from '../src/client/bonus-notices.ts'

const TIMING = { ackRetryDelayMs: 1_000, ackRetryMaxDelayMs: 60_000 }

/**
 * @param accountId - owning account.
 * @param orderId - server order.
 * @param expiresAt - server expiration.
 * @returns one unnotified bonus as the Host projects it.
 */
function batch(accountId: string, orderId: string, expiresAt = '2099-01-01T00:00:00Z'): AccountBonusBatch {
  return {
    accountId: accountId as AccountUserId,
    bonuses: [{
      orderId: orderId as AccountBonusOrderId,
      campaign: 'dsh_login_bonus',
      amount: '5.00',
      currency: 'CNY',
      grantedAt: '2026-09-21T12:00:00Z',
      expiresAt,
      message: 'Server copy 5.00',
    }],
  }
}

function setup() {
  const read = vi.fn(async (): Promise<AccountBonusBatch | null> => null)
  const acknowledge = vi.fn(async (): Promise<boolean> => true)
  const published: (BonusNotice | null)[] = []
  const controller = createBonusNoticeController({
    ...TIMING, read, acknowledge, publish: (notice) => { published.push(notice) },
  })
  /** @returns the most recently published notice. */
  const latest = (): BonusNotice | null | undefined => published.at(-1)
  return { controller, read, acknowledge, published, latest }
}

let visibility: 'visible' | 'hidden' = 'visible'
/** @param value - visibility the document reports. */
function setVisibility(value: 'visible' | 'hidden'): void {
  visibility = value
  document.dispatchEvent(new Event('visibilitychange'))
}

beforeEach(() => {
  visibility = 'visible'
  // jsdom exposes visibilityState as a getter the controller reads through properties it can be given.
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
})
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

it('reads once when the account becomes active and never on a timer', async () => {
  vi.useFakeTimers()
  const { controller, read } = setup()
  controller.begin()
  await vi.advanceTimersByTimeAsync(0)
  expect(read).toHaveBeenCalledTimes(1)
  // Nothing else schedules a read: only an explicit refresh does.
  await vi.advanceTimersByTimeAsync(TIMING.ackRetryMaxDelayMs)
  expect(read).toHaveBeenCalledTimes(1)
  await controller.refresh()
  await vi.advanceTimersByTimeAsync(0)
  expect(read).toHaveBeenCalledTimes(2)
  controller.end()
})

it('publishes the server copy for the first unnotified order', async () => {
  const { controller, read, latest } = setup()
  read.mockResolvedValue(batch('account-a', 'order-1'))
  controller.begin()
  await vi.waitFor(() => { expect(latest()).toMatchObject({ orderId: 'order-1', message: 'Server copy 5.00' }) })
  controller.end()
})

it('acknowledges only after the card reports a presented frame, then keeps the card until it is closed', async () => {
  const { controller, read, acknowledge, published, latest } = setup()
  read.mockResolvedValue(batch('account-a', 'order-1'))
  controller.begin()
  await vi.waitFor(() => { expect(latest()).toMatchObject({ orderId: 'order-1' }) })
  expect(acknowledge).not.toHaveBeenCalled()
  controller.shown('order-1' as AccountBonusOrderId)
  await vi.waitFor(() => { expect(acknowledge).toHaveBeenCalledWith('account-a', 'order-1') })
  // A refresh still offering the order must not republish the open card.
  const publishedBefore = published.length
  await controller.refresh()
  await vi.waitFor(() => { expect(read).toHaveBeenCalledTimes(2) })
  expect(published.length).toBe(publishedBefore)
  expect(latest()).toMatchObject({ orderId: 'order-1' })
  controller.dismiss('order-1' as AccountBonusOrderId)
  expect(latest()).toBeNull()
  expect(acknowledge).toHaveBeenCalledTimes(1)
  controller.end()
})

it('retries a failed acknowledgement with a growing backoff starting at the configured delay', async () => {
  vi.useFakeTimers()
  const { controller, read, acknowledge } = setup()
  read.mockResolvedValue(batch('account-a', 'order-1'))
  acknowledge.mockRejectedValue(new Error('offline'))
  controller.begin()
  await vi.advanceTimersByTimeAsync(0)
  controller.shown('order-1' as AccountBonusOrderId)
  await vi.advanceTimersByTimeAsync(0)
  expect(acknowledge).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(TIMING.ackRetryDelayMs - 1)
  expect(acknowledge).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(acknowledge).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(TIMING.ackRetryDelayMs * 2)
  expect(acknowledge).toHaveBeenCalledTimes(3)
  controller.end()
})

it('keeps acknowledging a presented notice while the window is hidden', async () => {
  const { controller, read, acknowledge } = setup()
  read.mockResolvedValue(batch('account-a', 'order-1'))
  controller.begin()
  await vi.waitFor(() => { expect(read).toHaveBeenCalledTimes(1) })
  controller.shown('order-1' as AccountBonusOrderId)
  setVisibility('hidden')
  // A pending record already means the card was presented, so the acknowledgement
  // still completes and no other device repeats the award.
  await vi.waitFor(() => { expect(acknowledge).toHaveBeenCalledTimes(1) })
  controller.end()
})

it('displays an order the server offers again after an earlier sign-in acknowledged it', async () => {
  const first = setup()
  first.read.mockResolvedValue(batch('account-a', 'order-1'))
  first.controller.begin()
  await vi.waitFor(() => { expect(first.latest()).toMatchObject({ orderId: 'order-1' }) })
  first.controller.shown('order-1' as AccountBonusOrderId)
  await vi.waitFor(() => { expect(first.acknowledge).toHaveBeenCalledTimes(1) })
  first.controller.end()
  // Nothing is remembered, so the same order the server still offers displays again.
  const second = setup()
  second.read.mockResolvedValue(batch('account-a', 'order-1'))
  second.controller.begin()
  await vi.waitFor(() => { expect(second.latest()).toMatchObject({ orderId: 'order-1' }) })
  second.controller.end()
})

it('acknowledges a re-offered order once per displayed card', async () => {
  const { controller, read, acknowledge, latest } = setup()
  read.mockResolvedValue(batch('account-a', 'order-1'))
  controller.begin()
  await vi.waitFor(() => { expect(latest()).toMatchObject({ orderId: 'order-1' }) })
  controller.shown('order-1' as AccountBonusOrderId)
  controller.shown('order-1' as AccountBonusOrderId)
  await vi.waitFor(() => { expect(acknowledge).toHaveBeenCalledTimes(1) })
  // Closing the card withdraws it; the next read of the same order is a new card.
  controller.dismiss('order-1' as AccountBonusOrderId)
  await vi.waitFor(() => { expect(acknowledge).toHaveBeenCalledTimes(1) })
  await controller.refresh()
  await vi.waitFor(() => { expect(latest()).toMatchObject({ orderId: 'order-1' }) })
  controller.shown('order-1' as AccountBonusOrderId)
  await vi.waitFor(() => { expect(acknowledge).toHaveBeenCalledTimes(2) })
  controller.end()
})

it('keeps the visible card when a read offers no bonus', async () => {
  const { controller, read, latest } = setup()
  read.mockResolvedValue(batch('account-a', 'order-1'))
  controller.begin()
  await vi.waitFor(() => { expect(latest()).toMatchObject({ orderId: 'order-1' }) })
  // A card the user has already seen keeps its place.
  controller.shown('order-1' as AccountBonusOrderId)
  // A Settings entry whose read returns nothing must not pull the card out from under the user.
  read.mockResolvedValue({ accountId: 'account-a' as AccountUserId, bonuses: [] })
  await controller.refresh()
  expect(latest()).toMatchObject({ orderId: 'order-1' })
  controller.dismiss('order-1' as AccountBonusOrderId)
  await controller.refresh()
  expect(latest()).toBeNull()
  controller.end()
})

it('keeps a pending acknowledgement for the signed-in lifecycle and drops it at sign-out', async () => {
  const { controller, read, acknowledge, latest } = setup()
  acknowledge.mockRejectedValue(new Error('offline'))
  read.mockResolvedValue(batch('account-a', 'order-1'))
  controller.begin()
  await vi.waitFor(() => { expect(latest()).toMatchObject({ orderId: 'order-1' }) })
  controller.shown('order-1' as AccountBonusOrderId)
  await vi.waitFor(() => { expect(acknowledge).toHaveBeenCalledWith('account-a', 'order-1') })
  await vi.waitFor(() => { expect(acknowledge.mock.calls.length).toBeGreaterThan(1) })
  // Signing out ends the retry with the lifecycle; the next sign-in starts clean.
  controller.end()
  const callsAtEnd = acknowledge.mock.calls.length
  const again = setup()
  again.read.mockResolvedValue(batch('account-a', 'order-1'))
  again.controller.begin()
  await vi.waitFor(() => { expect(again.latest()).toMatchObject({ orderId: 'order-1' }) })
  // The next sign-in must not inherit the earlier pending acknowledgement.
  expect(again.acknowledge).not.toHaveBeenCalled()
  expect(acknowledge.mock.calls.length).toBe(callsAtEnd)
  await new Promise((resolve) => { setTimeout(resolve, 5) })
  expect(acknowledge.mock.calls.length).toBe(callsAtEnd)
  again.controller.end()
})

it('ignores an acknowledgement that settles after the lifecycle it belonged to', async () => {
  const { controller, read, acknowledge, latest } = setup()
  read.mockResolvedValue(batch('account-a', 'order-1'))
  let settle: ((value: boolean) => void) | undefined
  acknowledge.mockImplementation(() => new Promise<boolean>((resolve) => { settle = resolve }))
  controller.begin()
  await vi.waitFor(() => { expect(latest()).toMatchObject({ orderId: 'order-1' }) })
  controller.shown('order-1' as AccountBonusOrderId)
  await vi.waitFor(() => { expect(acknowledge).toHaveBeenCalledTimes(1) })
  controller.end()
  // The new sign-in has its own pending queue; the old call settling later must not touch it.
  const next = setup()
  next.read.mockResolvedValue(batch('account-a', 'order-2'))
  next.controller.begin()
  await vi.waitFor(() => { expect(next.latest()).toMatchObject({ orderId: 'order-2' }) })
  next.controller.shown('order-2' as AccountBonusOrderId)
  await vi.waitFor(() => { expect(next.acknowledge).toHaveBeenCalledTimes(1) })
  settle?.(true)
  await new Promise((resolve) => { setTimeout(resolve, 5) })
  expect(next.acknowledge).toHaveBeenCalledTimes(1)
  expect(next.latest()).toMatchObject({ orderId: 'order-2' })
  next.controller.end()
})

it('does not let an in-flight acknowledgement of one account clear another account\'s queue', async () => {
  const { controller, read, acknowledge, latest } = setup()
  read.mockResolvedValue(batch('account-a', 'order-1'))
  let settleA: ((value: boolean) => void) | undefined
  acknowledge.mockImplementationOnce(() => new Promise<boolean>((resolve) => { settleA = resolve }))
  acknowledge.mockResolvedValue(true)
  controller.begin()
  await vi.waitFor(() => { expect(latest()).toMatchObject({ orderId: 'order-1' }) })
  controller.shown('order-1' as AccountBonusOrderId)
  await vi.waitFor(() => { expect(acknowledge).toHaveBeenCalledWith('account-a', 'order-1') })
  // Another account answers the same lifecycle before account-a's call settles.
  read.mockResolvedValue(batch('account-b', 'order-2'))
  await controller.refresh()
  await vi.waitFor(() => { expect(latest()).toMatchObject({ orderId: 'order-2' }) })
  settleA?.(true)
  await new Promise((resolve) => { setTimeout(resolve, 5) })
  // The stale answer settled account-a's order, not account-b's retry.
  expect(acknowledge).toHaveBeenCalledTimes(1)
  controller.shown('order-2' as AccountBonusOrderId)
  await vi.waitFor(() => { expect(acknowledge).toHaveBeenLastCalledWith('account-b', 'order-2') })
  controller.end()
})

it('restarts the retry delay after a lifecycle ends', async () => {
  vi.useFakeTimers()
  const { controller, read, acknowledge } = setup()
  read.mockResolvedValue(batch('account-a', 'order-1'))
  acknowledge.mockRejectedValue(new Error('offline'))
  controller.begin()
  await vi.advanceTimersByTimeAsync(0)
  controller.shown('order-1' as AccountBonusOrderId)
  await vi.advanceTimersByTimeAsync(TIMING.ackRetryDelayMs * 3)
  expect(acknowledge.mock.calls.length).toBeGreaterThan(2)
  controller.end()
  // The next lifecycle starts from the configured delay, not the previous backoff.
  const next = setup()
  next.read.mockResolvedValue(batch('account-a', 'order-2'))
  next.acknowledge.mockRejectedValue(new Error('offline'))
  next.controller.begin()
  await vi.advanceTimersByTimeAsync(0)
  next.controller.shown('order-2' as AccountBonusOrderId)
  await vi.advanceTimersByTimeAsync(0)
  expect(next.acknowledge).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(TIMING.ackRetryDelayMs - 1)
  expect(next.acknowledge).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(next.acknowledge).toHaveBeenCalledTimes(2)
  next.controller.end()
})

it('withdraws the displayed card when the signed-in account changes', async () => {
  const { controller, read, latest } = setup()
  read.mockResolvedValue(batch('account-a', 'order-1'))
  controller.begin()
  await vi.waitFor(() => { expect(latest()).toMatchObject({ orderId: 'order-1' }) })
  read.mockResolvedValue(batch('account-b', 'order-2'))
  await controller.refresh()
  await vi.waitFor(() => { expect(latest()).toMatchObject({ orderId: 'order-2' }) })
  controller.end()
})

it('never acknowledges after the plugin unloads', async () => {
  vi.useFakeTimers()
  const { controller, read, acknowledge } = setup()
  read.mockResolvedValue(batch('account-a', 'order-1'))
  controller.begin()
  await vi.advanceTimersByTimeAsync(0)
  controller.end()
  controller.shown('order-1' as AccountBonusOrderId)
  await vi.advanceTimersByTimeAsync(TIMING.ackRetryMaxDelayMs)
  expect(acknowledge).not.toHaveBeenCalled()
})

it('suppresses a bonus that expired before its first presented frame', async () => {
  const { controller, read, latest } = setup()
  read.mockResolvedValue(batch('account-a', 'order-1', '2000-01-01T00:00:00Z'))
  controller.begin()
  await vi.waitFor(() => { expect(read).toHaveBeenCalledTimes(1) })
  expect(latest()).toBeUndefined()
  controller.end()
})

it('does not record a display when the award expired before the card could render', async () => {
  const { controller, read, acknowledge, latest } = setup()
  read.mockResolvedValue(batch('account-a', 'order-1'))
  controller.begin()
  await vi.waitFor(() => { expect(latest()).toMatchObject({ orderId: 'order-1' }) })
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2100-01-01T00:00:00Z'))
  // The card refuses to render an expired award, so no display is reported.
  controller.shown('order-1' as AccountBonusOrderId)
  expect(acknowledge).not.toHaveBeenCalled()
  controller.end()
})
