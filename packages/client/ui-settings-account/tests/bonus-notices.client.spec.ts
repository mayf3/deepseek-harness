// @vitest-environment jsdom
/**
 * Bonus notice lifecycle: reads happen when the account becomes active and on
 * an explicit refresh, never on a timer; a notice is acknowledged only after
 * its card reports a presented frame, with retry, backoff, and durable
 * deduplication across pages and accounts.
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
  localStorage.clear()
  // jsdom exposes visibilityState as a getter the controller reads through properties it can be given.
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
})
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

it('reads once when the account becomes active and never on a timer', async () => {
  vi.useFakeTimers()
  const { controller, read } = setup()
  controller.begin('https://platform.test')
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
  controller.begin('https://platform.test')
  await vi.waitFor(() => { expect(latest()).toMatchObject({ orderId: 'order-1', message: 'Server copy 5.00' }) })
  controller.end()
})

it('acknowledges only after the card reports a presented frame, then keeps the card until it is closed', async () => {
  const { controller, read, acknowledge, published, latest } = setup()
  read.mockResolvedValue(batch('account-a', 'order-1'))
  controller.begin('https://platform.test')
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
  controller.begin('https://platform.test')
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
  controller.begin('https://platform.test')
  await vi.waitFor(() => { expect(read).toHaveBeenCalledTimes(1) })
  controller.shown('order-1' as AccountBonusOrderId)
  setVisibility('hidden')
  // A pending record already means the card was presented, so the acknowledgement
  // still completes and no other device repeats the award.
  await vi.waitFor(() => { expect(acknowledge).toHaveBeenCalledTimes(1) })
  controller.end()
})

it('does not repeat an order recorded by an earlier page or sign-in', async () => {
  const first = setup()
  first.read.mockResolvedValue(batch('account-a', 'order-1'))
  first.controller.begin('https://platform.test')
  await vi.waitFor(() => { expect(first.latest()).toMatchObject({ orderId: 'order-1' }) })
  first.controller.shown('order-1' as AccountBonusOrderId)
  await vi.waitFor(() => { expect(first.acknowledge).toHaveBeenCalledTimes(1) })
  first.controller.end()
  const second = setup()
  second.read.mockResolvedValue(batch('account-a', 'order-1'))
  second.controller.begin('https://platform.test')
  await vi.waitFor(() => { expect(second.read).toHaveBeenCalledTimes(1) })
  expect(second.published).toEqual([])
  // A new award still displays.
  second.read.mockResolvedValue(batch('account-a', 'order-2'))
  await second.controller.refresh()
  await vi.waitFor(() => { expect(second.latest()).toMatchObject({ orderId: 'order-2' }) })
  second.controller.end()
})

it('keeps a notice recorded for another account pending instead of clearing it', async () => {
  const { controller, read, acknowledge, latest } = setup()
  acknowledge.mockResolvedValue(false)
  read.mockResolvedValue(batch('account-a', 'order-1'))
  controller.begin('https://platform.test')
  await vi.waitFor(() => { expect(latest()).toMatchObject({ orderId: 'order-1' }) })
  controller.shown('order-1' as AccountBonusOrderId)
  await vi.waitFor(() => { expect(acknowledge).toHaveBeenCalledWith('account-a', 'order-1') })
  // A false answer stops this session; the record stays for account-a's next sign-in.
  read.mockResolvedValue(batch('account-b', 'order-2'))
  await controller.refresh()
  await vi.waitFor(() => { expect(latest()).toMatchObject({ orderId: 'order-2' }) })
  expect(acknowledge).toHaveBeenCalledTimes(1)
  controller.end()
  // Signing account-a back in retries its pending acknowledgement.
  const again = setup()
  again.read.mockResolvedValue(batch('account-a', 'order-1'))
  again.controller.begin('https://platform.test')
  await vi.waitFor(() => { expect(again.acknowledge).toHaveBeenCalledWith('account-a', 'order-1') })
  again.controller.end()
})

it('withdraws the displayed card when the signed-in account changes', async () => {
  const { controller, read, latest } = setup()
  read.mockResolvedValue(batch('account-a', 'order-1'))
  controller.begin('https://platform.test')
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
  controller.begin('https://platform.test')
  await vi.advanceTimersByTimeAsync(0)
  controller.end()
  controller.shown('order-1' as AccountBonusOrderId)
  await vi.advanceTimersByTimeAsync(TIMING.ackRetryMaxDelayMs)
  expect(acknowledge).not.toHaveBeenCalled()
})

it('suppresses a bonus that expired before its first presented frame', async () => {
  const { controller, read, latest } = setup()
  read.mockResolvedValue(batch('account-a', 'order-1', '2000-01-01T00:00:00Z'))
  controller.begin('https://platform.test')
  await vi.waitFor(() => { expect(read).toHaveBeenCalledTimes(1) })
  expect(latest()).toBeUndefined()
  controller.end()
})

it('does not record a display when the award expired before the card could render', async () => {
  const { controller, read, acknowledge, latest } = setup()
  read.mockResolvedValue(batch('account-a', 'order-1'))
  controller.begin('https://platform.test')
  await vi.waitFor(() => { expect(latest()).toMatchObject({ orderId: 'order-1' }) })
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2100-01-01T00:00:00Z'))
  // The card refuses to render an expired award, so no display is reported.
  controller.shown('order-1' as AccountBonusOrderId)
  expect(acknowledge).not.toHaveBeenCalled()
  controller.end()
})

it('keeps in-page deduplication when browser storage is unavailable', async () => {
  const denied = {
    getItem: () => { throw new Error('blocked') },
    setItem: () => { throw new Error('blocked') },
  } as unknown as Storage
  vi.spyOn(globalThis, 'localStorage', 'get').mockReturnValue(denied)
  const first = setup()
  first.read.mockResolvedValue(batch('account-a', 'order-1'))
  first.controller.begin('https://platform.test')
  await vi.waitFor(() => { expect(first.latest()).toMatchObject({ orderId: 'order-1' }) })
  first.controller.shown('order-1' as AccountBonusOrderId)
  await vi.waitFor(() => { expect(first.acknowledge).toHaveBeenCalledTimes(1) })
  first.controller.end()
  const second = setup()
  second.read.mockResolvedValue(batch('account-a', 'order-1'))
  second.controller.begin('https://platform.test')
  await vi.waitFor(() => { expect(second.read).toHaveBeenCalledTimes(1) })
  expect(second.published).toEqual([])
  second.controller.end()
})
