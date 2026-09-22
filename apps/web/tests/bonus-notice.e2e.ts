// Real-composition acceptance for the user-side bonus notice. The scaffold boots the
// shipped Web Loader tree, so the real account provider issues the bonus HTTP requests
// and the real client renders the card in a real Chromium. The loopback Platform double
// is the observation point: the scenario asserts what the product sent and what the user
// could read on screen.
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Locator, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  assertFixtureInventory, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { openSettings, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./expected/bonus-notice', import.meta.url))
const OVERLAY_TEMPLATE = fileURLToPath(new URL('./fixtures/bonus-notice/cordis.patch.yml', import.meta.url))
const MODE = webSnapshotMode()

const TOKEN = 'dsh_bonus_notice_test'
const ORDER_FIRST = '22222222-2222-4222-8222-222222222222'
const ORDER_LATER = '33333333-3333-4333-8333-333333333333'
const ORDER_EN = '44444444-4444-4444-8444-444444444444'

const CLAIM_DAYS = 30

/** Eligibility window the double reports; neither the card nor the golden renders a date. */
function expiresAt(): string {
  return new Date(Date.now() + CLAIM_DAYS * 86_400_000).toISOString()
}

interface Granted {
  readonly orderId: string
  readonly amount: string
  readonly zh_CN: string
  readonly en_US: string
}

interface GetRecord {
  readonly locale: string | undefined
  readonly query: string
}

interface AckRecord {
  readonly method: string
  readonly path: string
  readonly locale: string | undefined
  readonly orderId: string | null
  readonly body: string
}

/** Loopback Platform double: auth gate, profile, wallets, unnotified bonuses, and the acknowledgement. */
async function mockPlatform() {
  const unnotified: Granted[] = []
  const gets: GetRecord[] = []
  /** Reads already answered; a request the client is still awaiting is not evidence of a delivered response. */
  const served: GetRecord[] = []
  const acks: AckRecord[] = []
  let bonusBalance = '5.00'
  /** Reply held back while the test controls when a read can answer. */
  let heldReply: (() => void) | undefined
  const grant = (orderId: string, amount: string): void => {
    unnotified.unshift({
      orderId, amount,
      zh_CN: `已赠送您 ${amount} 元 DSH 体验赠金。`,
      en_US: `You received a CNY ${amount} DSH trial credit.`,
    })
  }
  /** @param value - granted bonus. @param locale - request language. @returns its wire fields. */
  const wire = (value: Granted, locale: string | undefined): unknown => ({
    order_id: value.orderId, campaign: 'dsh_login_bonus', amount: value.amount, currency: 'CNY',
    granted_at: new Date().toISOString(), expires_at: expiresAt(),
    msg: locale === 'en_US' ? value.en_US : value.zh_CN,
  })
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const header = req.headers['x-client-locale']
    const locale = typeof header === 'string' ? header : undefined
    const reply = (payload: unknown): void => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    }
    if (req.headers['x-dsh-auth-token'] !== TOKEN) { res.writeHead(401).end(); return }
    if (url.pathname === '/auth-api/v0/users/current') {
      // `email` is required by the provider's profile schema even when the account has none.
      reply({ code: 0, data: { biz_code: 0, biz_data: {
        id: 'bonus-user', email: '', id_profile: { name: 'Bonus User', picture: null },
      } } })
      return
    }
    if (url.pathname === '/api/v0/users/get_user_summary') {
      reply({ code: 0, data: { biz_code: 0, biz_data: {
        normal_wallets: [{ currency: 'CNY', balance: '12.34' }],
        bonus_wallets: [{ currency: 'CNY', balance: bonusBalance }],
      } } })
      return
    }
    if (url.pathname === '/api/v0/users/get_unnotified_bonuses') {
      const record = { locale, query: url.search }
      gets.push(record)
      const payload = { code: 0, data: { biz_code: 0, biz_data: unnotified.map(value => wire(value, locale)) } }
      const answer = (): void => { served.push(record); reply(payload) }
      if (heldReply === undefined) { answer(); return }
      heldReply = answer
      return
    }
    if (url.pathname === '/api/v0/users/ack_bonus_notified' && req.method === 'POST') {
      let body = ''
      req.setEncoding('utf8')
      req.on('data', (chunk: string) => { body += chunk })
      req.on('end', () => {
        const orderId = url.searchParams.get('order_id')
        acks.push({ method: req.method ?? '', path: url.pathname, locale, orderId, body })
        if (orderId === null) { reply({ code: 1, msg: 'BONUS_ORDER_NOT_FOUND', data: null }); return }
        const index = unnotified.findIndex(value => value.orderId === orderId)
        if (index >= 0) unnotified.splice(index, 1)
        reply({ code: 0, msg: '', data: { biz_code: 0, biz_msg: '', biz_data: null } })
      })
      return
    }
    if (url.pathname === '/auth-api/v0/users/logout') { reply({ code: 0, data: { biz_code: 0, biz_data: null } }); return }
    res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('bonus notice: missing mock listener')
  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    grant, gets, served, acks,
    /** @param value - bonus balance the settings page reads next. */
    setBonusBalance: (value: string): void => { bonusBalance = value },
    /** Hold the next unnotified-bonus read so the test can observe the in-flight state. */
    holdNextGet: (): void => { heldReply = () => undefined },
    releaseGet: (): void => { const held = heldReply; heldReply = undefined; held?.() },
    close: () => new Promise<void>((resolve) => { server.close(() => { resolve() }); server.closeAllConnections() }),
  }
}

/** @param page - page under test. @returns every rendered bonus notice card. */
function noticeCards(page: Page): Locator {
  return page.locator('aside').filter({ hasText: '赠金已到账' })
}

/** @param card - a rendered notice card. @returns its non-empty visible lines joined for the golden. */
async function cardText(card: Locator): Promise<string> {
  return (await card.innerText()).split('\n').map(line => line.trim()).filter(line => line !== '').join(' / ')
}

/** Wait for the card carrying this copy, then return the text the user could read from it. */
async function shownNotice(page: Page, copy: string): Promise<string> {
  const card = noticeCards(page).filter({ hasText: copy })
  await card.waitFor({ state: 'visible', timeout: 30_000 })
  return cardText(card)
}

/** Wait for the double to answer this many acknowledgements, then return the order ids in arrival order. */
async function acked(platform: { acks: AckRecord[] }, count: number): Promise<string> {
  await expect.poll(() => platform.acks.length, { timeout: 30_000 }).toBe(count)
  return platform.acks.map(item => String(item.orderId)).join(',')
}

describe.skipIf(MODE === 'record')('web e2e: bonus notice', () => {
  let root: string | undefined
  let scaffold: WebScaffold
  let browser: Browser
  let platform: Awaited<ReturnType<typeof mockPlatform>>
  const tripwires: ReturnType<typeof watchConsole>[] = []

  /** @param locale - browser language driving the requested notice locale. @returns a desktop-renderer page. */
  const openDesktopPage = async (locale: string): Promise<Page> => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, locale })
    const opened = await context.newPage()
    tripwires.push(watchConsole(opened))
    await opened.addInitScript(() => {
      Object.defineProperty(globalThis, 'dshDesktop', { value: { protocolVersion: 1 } })
    })
    return opened
  }

  beforeAll(async () => {
    platform = await mockPlatform()
    platform.grant(ORDER_FIRST, '5.00')
    root = await mkdtemp(join(tmpdir(), 'dsh-bonus-notice-'))
    const home = join(root, 'home')
    await mkdir(home, { recursive: true })
    // A stored grant bound to the double's origin starts the account credential-stored
    // without driving the browser sign-in flow.
    await writeFile(join(home, '.credentials.yaml'),
      `version: 1\nrefs: {}\nrecords:\n  deepseek-account-platform/default:\n    kind: grant\n    payload:\n      version: 1\n      token: ${TOKEN}\n      issuer: ${platform.origin}\n`,
      { mode: 0o600 })
    const overlay = join(root, 'bonus-notice.overlay.yml')
    await writeFile(overlay, (await readFile(OVERLAY_TEMPLATE, 'utf8')).replaceAll('{{origin}}', platform.origin))
    scaffold = await launchWebScaffold({ harnessHome: home, extraOverlayPath: overlay })
    browser = await chromium.launch()
  })

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    await platform?.close()
    if (root !== undefined) await rm(root, { recursive: true, force: true })
  })

  it('acknowledges only a displayed notice, refreshes from settings, and localizes the request', async () => {
    const zhFirst = '已赠送您 5.00 元 DSH 体验赠金。'
    const zhLater = '已赠送您 8.00 元 DSH 体验赠金。'
    const enBonus = 'You received a CNY 9.00 DSH trial credit.'
    const observations: string[] = []
    const page = await openDesktopPage('zh-CN')
    onTestFailed(() => saveFailureShot(page, 'web-e2e-bonus-notice'))

    // A read the renderer never received cannot become a displayed notice: while the
    // response is held there is no card and no acknowledgement.
    platform.holdNextGet()
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await expect.poll(() => platform.gets.length, { timeout: 30_000 }).toBe(1)
    observations.push(`startup.held cards=${String(await noticeCards(page).count())} acks=${String(platform.acks.length)}`)
    expect(await noticeCards(page).count()).toBe(0)
    expect(platform.acks).toEqual([])
    platform.releaseGet()

    // Startup signs in and reads the notice; the card shows it and only then is it acknowledged.
    observations.push(`startup.notice=${await shownNotice(page, zhFirst)}`)
    observations.push(`startup.ack orders=${await acked(platform, 1)}`)
    const get = platform.gets[0]!
    const ack = platform.acks[0]!
    observations.push(`startup.get locale=${String(get.locale)} query=${get.query}`)
    observations.push(`startup.ack method=${ack.method} path=${ack.path} locale=${String(ack.locale)} order_id=${String(ack.orderId)} body=${JSON.stringify(ack.body)}`)
    expect(get.locale).toBe('zh_CN')
    expect(get.query).toBe('')
    expect(ack).toMatchObject({
      method: 'POST', path: '/api/v0/users/ack_bonus_notified', locale: 'zh_CN', orderId: ORDER_FIRST, body: '',
    })

    // Closing the card counts as reading it and never acknowledges it twice.
    await noticeCards(page).getByRole('button', { name: '关闭', exact: true }).click()
    expect(await noticeCards(page).count()).toBe(0)
    expect(platform.acks).toHaveLength(1)

    // A new grant and balance arrive while settings is open. Refresh fetches both, but
    // the card is gated on settings being closed, so the served response is not displayed
    // and must not be acknowledged yet.
    await openSettings(page, 'zh')
    const settings = page.getByRole('dialog', { name: '设置', exact: true })
    const refresh = settings.getByRole('button', { name: '刷新余额', exact: true })
    await refresh.waitFor()
    platform.grant(ORDER_LATER, '8.00')
    platform.setBonusBalance('13.00')
    const getsBefore = platform.gets.length
    // Hold the refresh's notice read so the test observes the button's in-flight state
    // instead of racing a fast local response.
    platform.holdNextGet()
    await refresh.click()
    await expect.poll(() => platform.gets.length, { timeout: 30_000 }).toBe(getsBefore + 1)
    expect(platform.gets.length).toBe(getsBefore + 1)
    await expect.poll(() => refresh.isDisabled(), { timeout: 30_000 }).toBe(true)
    // The read is in flight: no card, no acknowledgement, and the button has not re-enabled.
    observations.push(`refresh.held cards=${String(await noticeCards(page).count())} acks=${String(platform.acks.length)}`)
    expect(await noticeCards(page).count()).toBe(0)
    expect(platform.acks).toHaveLength(1)
    platform.releaseGet()
    // The refresh completed only once the button re-enabled, which follows both the
    // balance read and the notice read settling.
    await expect.poll(() => refresh.isDisabled(), { timeout: 30_000 }).toBe(false)
    await expect.poll(async () => (await settings.textContent()) ?? '', { timeout: 30_000 }).toContain('¥13.00')

    const refreshGet = platform.served.at(-1)!
    const panel = (await settings.textContent()) ?? ''
    const usage = await settings.getByRole('link', { name: '查询用量', exact: true }).getAttribute('href')
    observations.push(`refresh.get locale=${String(refreshGet.locale)} query=${refreshGet.query} served=true`)
    observations.push(`refresh.balance bonus-row=${String(panel.includes('赠金余额'))} amount=${String(panel.includes('¥13.00'))} dated=${String(/\d{4}-\d{2}-\d{2}/.test(panel))}`)
    observations.push(`refresh.cards-while-settings-open=${String(await noticeCards(page).count())} acks=${String(platform.acks.length)}`)
    observations.push(`refresh.usage-link=${String(usage).replace(platform.origin, '{{origin}}')}`)
    expect(refreshGet.locale).toBe('zh_CN')
    expect(refreshGet.query).toBe('')
    expect(panel).toContain('赠金余额')
    expect(panel).toContain('¥13.00')
    expect(panel).not.toMatch(/\d{4}-\d{2}-\d{2}/)
    expect(usage).toBe(`${platform.origin}/usage`)
    expect(await noticeCards(page).count()).toBe(0)
    expect(platform.acks).toHaveLength(1)

    // Leaving settings releases the already-fetched notice; it is displayed, and only now acknowledged.
    await page.keyboard.press('Escape')
    observations.push(`refresh.released notice=${await shownNotice(page, zhLater)}`)
    observations.push(`refresh.released ack orders=${await acked(platform, 2)}`)
    await page.close()

    // Another device in another language gets the copy the server localized for it.
    platform.grant(ORDER_EN, '9.00')
    const enPage = await openDesktopPage('en-US')
    await enPage.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    const enCard = enPage.locator('aside').filter({ hasText: 'Bonus credited' }).filter({ hasText: enBonus })
    await enCard.waitFor({ state: 'visible', timeout: 30_000 })
    observations.push(`en.notice=${await cardText(enCard)}`)
    const enGet = platform.gets.find(entry => entry.locale === 'en_US')!
    observations.push(`en.get locale=${String(enGet.locale)} query=${enGet.query}`)
    expect(enGet.locale).toBe('en_US')
    expect(enGet.query).toBe('')

    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'notice-flow.expected.md'), observations.join('\n'), MODE)
    for (const tripwire of tripwires) {
      expect(tripwire.warnings).toEqual([])
      expect(tripwire.pageErrors).toEqual([])
    }
    await assertFixtureInventory(SNAPSHOT_DIR, ['notice-flow.expected.md'])
  }, 180_000)
})
