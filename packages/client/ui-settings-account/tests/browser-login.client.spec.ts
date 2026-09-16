// @vitest-environment jsdom
/** Browser handoff tracks the initiating attempt and cleans up unused tabs. */
import { afterEach, expect, it, vi } from 'vitest'
import type { AccountView, SignInAttemptId } from '@deepseek-ai/dsh-deepseek-account/types'
import { BrowserLogin } from '../src/client/browser-login.ts'

afterEach(() => { vi.restoreAllMocks() })
function view(phase: NonNullable<AccountView['attempt']>['phase'], authorizeUrl?: string): AccountView {
  return { status: 'signed-out', links: { usageUrl: '', topUpUrl: '' },
    attempt: { id: 'attempt' as SignInAttemptId, phase, ...(authorizeUrl ? { authorizeUrl } : {}) } }
}
function setup() {
  const close = vi.fn()
  const replace = vi.fn()
  const popup = { closed: false, opener: window, close, location: { replace } }
  vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
  const browser = new BrowserLogin()
  browser.begin()
  return { browser, popup, close, replace }
}
it('navigates once when waiting-browser arrives after the initial RPC response', () => {
  const { browser, popup, replace, close } = setup()
  expect(popup.opener).toBeNull()
  browser.follow(view('initializing'))
  expect(replace).not.toHaveBeenCalled()
  browser.update(view('waiting-browser', 'https://platform.deepseek.com/dsh/authorize'))
  browser.update(view('waiting-browser', 'https://platform.deepseek.com/dsh/authorize'))
  expect(replace).toHaveBeenCalledExactlyOnceWith('https://platform.deepseek.com/dsh/authorize')
  browser.dispose()
  expect(close).toHaveBeenCalledOnce()
})
it('closes the blank tab on request failure without later navigating it', () => {
  const { browser, close, replace } = setup()
  browser.dispose()
  browser.update(view('waiting-browser', 'https://platform.deepseek.com/dsh/authorize'))
  expect(close).toHaveBeenCalledOnce()
  expect(replace).not.toHaveBeenCalled()
})
it('retains the manual link route when popup opening is blocked', () => {
  vi.spyOn(window, 'open').mockReturnValue(null)
  const browser = new BrowserLogin()
  browser.begin()
  expect(() => { browser.follow(view('waiting-browser', 'https://platform.deepseek.com/dsh/authorize')) }).not.toThrow()
})

it('closes the pending tab when the authenticated start request rejects', async () => {
  const { browser, close, replace } = setup()
  close.mockClear()
  await expect(browser.start(() => Promise.reject(new Error('disconnected')), () => undefined)).rejects.toThrow('disconnected')
  expect(close).toHaveBeenCalledTimes(2)
  expect(replace).not.toHaveBeenCalled()
})
it('uses a waiting frame received before the initial response', async () => {
  const { browser, replace } = setup()
  await browser.start(async () => view('initializing'), () => view('waiting-browser', 'https://platform.deepseek.com/dsh/authorize'))
  expect(replace).toHaveBeenCalledExactlyOnceWith('https://platform.deepseek.com/dsh/authorize')
})

it.each(['failed', 'expired', 'cancelled'] as const)('closes an already navigated tab on %s', (phase) => {
  const { browser, close } = setup()
  browser.follow(view('waiting-browser', 'https://platform.deepseek.com/dsh/authorize'))
  browser.update(view(phase))
  expect(close).toHaveBeenCalledOnce()
})
it('leaves success completion to the Platform page', () => {
  const { browser, close } = setup()
  browser.follow(view('waiting-browser', 'https://platform.deepseek.com/dsh/authorize'))
  browser.update(view('succeeded'))
  browser.dispose()
  expect(close).not.toHaveBeenCalled()
})
