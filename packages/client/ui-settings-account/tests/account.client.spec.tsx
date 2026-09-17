// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, act } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import type { AccountDetails, AccountView, SignInAttemptId } from '@deepseek-ai/dsh-deepseek-account/types'
import type { PlatformBridge } from '../src/client/PlatformOverlay.tsx'
import { AccountSection, type AccountSectionInjected } from '../src/client/AccountSection.tsx'
import type {} from '../src/client/index.ts'
import { en, zh, type AccountKey } from '../src/client/locales.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function mount(state: Omit<AccountView, 'links'>, copy: typeof en | typeof zh = en, details?: Partial<AccountDetails>, platform?: PlatformBridge) {
  const operations: AccountSectionInjected = {
    ...platform === undefined ? {} : { platform },
    hooks: { account: {
      getSnapshot: () => ({ view: { ...state, links: { usageUrl: 'http://localhost:8081/usage', topUpUrl: 'http://localhost:8081/top_up' } }, details, failed: false }),
      subscribe: () => () => {},
    } },
    contactUs: vi.fn(), showLogin: vi.fn(), setOnboarding: vi.fn(),
    refresh: vi.fn(() => Promise.resolve()),
    start: vi.fn(() => Promise.resolve()), cancel: vi.fn(() => Promise.resolve()), signOut: vi.fn(() => Promise.resolve()),
  }
  // AccountSection consumes no global hooks; the slot supplies them in the application.
  const globals = {} as GlobalStandardProps
  render(<AccountSection {...globals} {...operations}
    useAccount={selector => selector(operations.hooks.account.getSnapshot())}
    close={() => {}} t={key => key in copy ? copy[key as AccountKey] : key} />)
  return operations
}

it.each([en, zh])('renders account cards without inventing profile or balance data', async (copy) => {
  mount({ status: 'credential-stored', attempt: null }, copy)
  expect(screen.getByText(copy.signedIn)).toBeTruthy()
  expect(screen.getAllByText(copy.loading)).toHaveLength(2)
  expect(screen.getByRole('link', { name: copy.usage }).getAttribute('href')).toBe('http://localhost:8081/usage')
  expect(screen.getByRole('link', { name: copy.topUp }).getAttribute('href')).toBe('http://localhost:8081/top_up')
  expect(screen.queryByRole('button', { name: copy.signOut })).toBeNull()
  expect(document.body.textContent).not.toContain('209.00')
  await expect(`${screen.getByRole('region').textContent}\n`).toMatchFileSnapshot(`./expected/account-${copy === en ? 'en' : 'zh'}.txt`)
})

it('starts sign-in and disables cancellation during persistence', async () => {
  const operations = mount({ status: 'signed-out', attempt: null })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.signIn })) })
  expect(operations.start).toHaveBeenCalledOnce()
  cleanup()
  mount({ status: 'signed-out', attempt: { id: 'attempt' as SignInAttemptId, phase: 'committing' } })
  expect(screen.getByRole('button', { name: en.cancel }).hasAttribute('disabled')).toBe(true)
  expect(screen.queryByRole('button', { name: en.signIn })).toBeNull()
})

it.each([en, zh])('opens settings and signs out from the sidebar account menu', async (copy) => {
  const signOut = vi.fn(() => Promise.resolve())
  const openSettings = vi.fn()
  const operations = mount({ status: 'credential-stored', attempt: null }, copy)
  cleanup()
  const { AccountMenu } = await import('../src/client/AccountMenu.tsx')
  render(<AccountMenu {...({} as GlobalStandardProps)} {...operations} signOut={signOut}
    useAccount={selector => selector(operations.hooks.account.getSnapshot())} wide openOnboarding={() => {}} openSettings={openSettings}
    t={key => key in copy ? copy[key as AccountKey] : key} />)
  fireEvent.click(screen.getByRole('button', { name: copy.menu }))
  expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual([copy.settings, copy.contactUs, copy.signOut])
  await expect(`${screen.getByRole('menu').textContent}\n`).toMatchFileSnapshot(`./expected/menu-${copy === en ? 'en' : 'zh'}.txt`)
  fireEvent.click(screen.getByRole('menuitem', { name: copy.settings }))
  expect(openSettings).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: copy.menu }))
  fireEvent.click(screen.getByRole('menuitem', { name: copy.contactUs }))
  expect(operations.contactUs).toHaveBeenCalledOnce()
  expect(screen.queryByRole('menu')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: copy.menu }))
  await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: copy.signOut })) })
  expect(signOut).toHaveBeenCalledOnce()
  expect(screen.queryByRole('menu')).toBeNull()
})

it.each([en, zh])('renders Platform profile and recharge wallet balances', async (copy) => {
  mount({ status: 'credential-stored', attempt: null }, copy, {
    profile: { status: 'ready', value: { id: null, name: 'Harness Mock (TEST ONLY)', contact: '138****0000' } },
    balance: { status: 'ready', value: [{ currency: 'CNY', balance: '1234.56000000' }, { currency: 'USD', balance: '0.00000100' }] },
  })
  expect(screen.getByText('Harness Mock (TEST ONLY)')).toBeTruthy()
  expect(screen.getByText('138****0000')).toBeTruthy()
  expect(screen.getByText('¥1,234.56')).toBeTruthy()
  expect(screen.getByText('<$0.01')).toBeTruthy()
  await expect(`${screen.getByRole('region').textContent}\n`).toMatchFileSnapshot(`./expected/details-${copy === en ? 'en' : 'zh'}.txt`)
})

it.each([en, zh])('shows the signed-out settings prompt without balance or Platform links', async (copy) => {
  mount({ status: 'signed-out', attempt: null }, copy)
  expect(screen.getByText(copy.settingsSignedOutTitle)).toBeTruthy()
  expect(screen.getByText(copy.settingsSignedOutDescription)).toBeTruthy()
  expect(screen.queryByText(copy.balance)).toBeNull()
  expect(screen.queryByRole('link')).toBeNull()
  await expect(`${screen.getByRole('region').textContent}\n`)
    .toMatchFileSnapshot(`./expected/account-signed-out-${copy === en ? 'en' : 'zh'}.txt`)
})


it('opens usage inside Desktop and returns to the same Account settings', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  const platform: PlatformBridge = { open: vi.fn(async () => {}), setBounds: vi.fn(async () => {}), close: vi.fn(async () => {}) }
  mount({ status: 'credential-stored', attempt: null }, en, undefined, platform)
  await act(async () => { fireEvent.click(screen.getByRole('link', { name: en.usage })) })
  expect(platform.open).toHaveBeenCalledWith('usage', { x: 0, y: 0, width: 0, height: 0 })
  const back = screen.getByRole('button', { name: en.backToHarness })
  await expect(`${back.parentElement!.parentElement!.textContent}\n`).toMatchFileSnapshot('./expected/platform-header-en.txt')
  await act(async () => { fireEvent.click(back) })
  expect(platform.close).toHaveBeenCalledOnce()
  expect(screen.queryByRole('button', { name: en.backToHarness })).toBeNull()
  expect(screen.getByRole('region', { name: en.nav })).toBeTruthy()
})

it('keeps a return action available when the native document fails to load', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  const platform: PlatformBridge = {
    open: vi.fn(async () => { throw new Error('load failed') }), setBounds: vi.fn(async () => {}), close: vi.fn(async () => {}),
  }
  mount({ status: 'credential-stored', attempt: null }, zh, undefined, platform)
  await act(async () => { fireEvent.click(screen.getByRole('link', { name: zh.topUp })) })
  expect(platform.open).toHaveBeenCalledWith('top-up', { x: 0, y: 0, width: 0, height: 0 })
  expect(screen.getByText(zh.failed)).toBeTruthy()
  const back = screen.getByRole('button', { name: zh.backToHarness })
  await expect(`${back.parentElement!.parentElement!.textContent}\n`).toMatchFileSnapshot('./expected/platform-header-zh.txt')
  await act(async () => { fireEvent.click(back) })
  expect(platform.close).toHaveBeenCalledOnce()
})

it('shows the profile while the balance is still loading', async () => {
  mount({ status: 'credential-stored', attempt: null }, en, {
    profile: { status: 'ready', value: { id: null, name: 'Ready User', contact: '138****0000' } },
  })
  expect(screen.getByText('Ready User')).toBeTruthy()
  expect(screen.getByText(en.loading)).toBeTruthy()
  expect(screen.queryByText(en.balanceUnavailable)).toBeNull()
  await expect(`${screen.getByRole('region').textContent}\n`).toMatchFileSnapshot('./expected/profile-before-balance.txt')
})


it.each(['usage', 'top-up'] as const)('shows an accessible spinner until %s finishes loading', async (page) => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  const loaded = Promise.withResolvers<undefined>()
  const platform: PlatformBridge = { open: () => loaded.promise, setBounds: async () => {}, close: async () => {} }
  mount({ status: 'credential-stored', attempt: null }, en, undefined, platform)
  await act(async () => { fireEvent.click(screen.getByRole('link', { name: page === 'usage' ? en.usage : en.topUp })) })
  const status = screen.getByRole('status', { name: en.loading })
  expect({ accessibleName: status.getAttribute('aria-label'), visibleText: status.textContent }).toMatchInlineSnapshot(`
    {
      "accessibleName": "Loading…",
      "visibleText": "",
    }
  `)
  expect(status.querySelector('[aria-hidden="true"]')).not.toBeNull()
  expect(screen.getByRole('button', { name: en.backToHarness })).toBeTruthy()
  await act(async () => { loaded.resolve(undefined) })
  expect(screen.queryByRole('status', { name: en.loading })).toBeNull()
})


it.each([
  ['Preferred name', '138****0000', 'Preferred name'],
  [null, '138****0000', '138****0000'],
  [null, 'u***@example.com', 'u***@example.com'],
  [null, null, en.signedIn],
])('uses the sidebar profile label %s / %s', async (name, contact, expected) => {
  const operations = mount({ status: 'credential-stored', attempt: null }, en, {
    profile: { status: 'ready', value: { id: null, name, contact } },
  })
  cleanup()
  const { AccountMenu } = await import('../src/client/AccountMenu.tsx')
  render(<AccountMenu {...({} as GlobalStandardProps)} {...operations}
    useAccount={selector => selector(operations.hooks.account.getSnapshot())}
    wide openSettings={() => {}} openOnboarding={() => {}} t={key => en[key as AccountKey]} />)
  expect(screen.getByRole('button', { name: en.menu }).textContent).toBe(expected)
})
