import { createHash } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createServer as createTcpServer, connect, type Socket } from 'node:net'
import { join } from 'node:path'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials'
import { Config, PlatformAccount } from '../src/index.ts'
import { browserUrl, platformHeaders, platformOrigin, loginOrigin } from '../src/protocol.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()!() })

async function fixture(
  contact: { email: string; mobile?: string; mobile_number?: string } = {
    email: 't***@example.invalid', mobile: '138****5678',
  },
  requestHeaders: Record<string, string> = {},
  rewriteBrowserOrigin = false,
  accountRequestHeaders: Record<string, string> = {},
  inferenceOrigin = 'https://api.deepseek.com',
  beforeAccount?: (ctx: Context, origin: string) => Promise<void>,
  embeddedPageDist = '',
  desktopPlatform: 'darwin' | 'win32' | null = null,
) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-account-'))
  cleanups.push(() => rm(home, { recursive: true, force: true }))
  let init: Record<string, string> = {}
  const cancellations: Array<Record<string, string>> = []
  const cancellationReceived = Promise.withResolvers<undefined>()
  let holdCancel = false
  const exchanged = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  let redirect = false
  let hold = false
  let count = 0
  let businessCode = 0
  let exchangeOverride: Record<string, unknown> = {}
  let initOverride: Record<string, unknown> = {}
  let origin = ''
  let detailsHold = false
  let balanceHold = false
  let profileFailed = false
  let summaryFailed = false
  let logoutFailed = false
  let logoutHold = false
  let logoutCount = 0
  const logoutHeaders: Array<string | undefined> = []
  let invalidSummary = false
  const detailsStarted = Promise.withResolvers<undefined>()
  const detailRequests: Array<{ path: string; authorization: string | undefined }> = []
  const receivedHeaders: Array<{
    clientPlatform: string | undefined
    path: string | undefined
    cookie: string | undefined
    authorization: string | undefined
  }> = []
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    expect(req.headers.authorization).toBeUndefined()
    receivedHeaders.push({ clientPlatform: req.headers['x-client-platform'] as string | undefined, path: req.url, cookie: req.headers.cookie, authorization: req.headers['x-dsh-auth-token'] as string | undefined })
    if (redirect) { res.writeHead(302, { location: `${origin}/redirect-target` }).end(); return }
    if (req.url === '/auth-api/v0/users/logout') {
      logoutCount++
      logoutHeaders.push(req.headers['x-dsh-auth-token'] as string | undefined)
      if (logoutHold) await release.promise
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ code: logoutFailed ? 50000 : 0, data: { biz_code: 0, biz_data: null } }))
      return
    }
    if (req.method === 'GET') {
      detailRequests.push({ path: req.url!, authorization: req.headers['x-dsh-auth-token'] as string | undefined })
      detailsStarted.resolve(undefined)
      if (detailsHold || (balanceHold && req.url === '/api/v0/users/get_user_summary')) await release.promise
      const value = req.url === '/auth-api/v0/users/current'
        ? { id: 'test-user', token: 'never-copy-response-token', ...contact,
          id_profile: { name: 'Test Account', picture: null } }
        : { normal_wallets: [{ currency: 'CNY', balance: invalidSummary ? 'not-a-decimal' : '123.45', token_estimation: '0' },
          { currency: 'USD', balance: '6.78', token_estimation: '0' }],
        bonus_wallets: [{ currency: 'CNY', balance: '10.00' }] }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ code: 0, data: {
        biz_code: (profileFailed && req.url === '/auth-api/v0/users/current')
          || (summaryFailed && req.url === '/api/v0/users/get_user_summary') ? 17 : 0, biz_data: value,
      } }))
      return
    }
    req.setEncoding('utf8')
    let text = ''
    for await (const chunk of req) {
      if (typeof chunk !== 'string') throw new Error('expected UTF-8 chunk')
      text += chunk
    }
    const body = JSON.parse(text) as Record<string, string>
    let value: unknown
    if (req.url?.endsWith('auth_cancel')) {
      cancellations.push(body)
      cancellationReceived.resolve(undefined)
      if (holdCancel) await release.promise
      value = null
    } else if (req.url?.endsWith('auth_init')) {
      init = body
      value = { authorize_url: `${rewriteBrowserOrigin ? 'https://platform.deepseek.com' : origin}/dsh/authorize?authorize_id=test`, expires_in: 600, authorize_id: 'test', ...initOverride }
    } else {
      count++
      exchanged.resolve(undefined)
      if (hold) await release.promise
      value = { user: null, token: 'dsh_mock_test', authorized_url: `${origin}/dsh/authorized?result=test&locale=zh_CN`, ...exchangeOverride }
    }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ code: 0, data: { biz_code: businessCode, biz_msg: 'sensitive diagnostic', biz_data: value } }))
  }
  const server = createServer((req, res) => { void handle(req, res).catch(() => { res.writeHead(500).end() }) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing listener')
  origin = `http://127.0.0.1:${address.port}`
  cleanups.push(async () => {
    release.resolve(undefined)
    await new Promise<void>((resolve) => { server.close(() => { resolve() }); server.closeAllConnections() })
  })
  const ctx = new Context()
  const web = ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await web
  const callbackOrigin = `http://127.0.0.1:${ctx.webServer.port}`
  const credentials = ctx.plugin(LocalCredentialProvider, { path: join(home, 'credentials.yaml'), watch: false })
  await credentials
  const authorization = ctx.plugin(AuthorizationService)
  await authorization
  await beforeAccount?.(ctx, origin)
  const provider = ctx.plugin(PlatformAccount, {
    platformOrigin: origin, inferenceOrigin, embeddedPageDist, desktopPlatform,
    allowLoopbackHttp: true, requestHeaders, accountRequestHeaders,
    rewriteBrowserOrigin, logoutRetryDelayMs: 1,
  })
  await provider
  cleanups.push(async () => { await provider.dispose(); await authorization.dispose(); await credentials.dispose(); await web.dispose() })
  const account = ctx.deepseekAccount
  const states = new AbortController()
  cleanups.push(async () => { states.abort() })
  async function wait(phase: string) {
    for await (const state of account.watch(states.signal)) if (state.attempt?.phase === phase) return state
    throw new Error(`missing phase ${phase}`)
  }
  return { cancellations, cancellationReceived, holdCancel: () => { holdCancel = true },
    ctx, account, home, origin, callbackOrigin, wait, receivedHeaders, logoutHeaders, logoutCount: () => logoutCount,
    holdLogout: () => { logoutHold = true },
    failLogout: (failed: boolean) => { logoutFailed = failed }, detailRequests, detailsStarted,
    failProfile: (failed: boolean) => { profileFailed = failed },
    holdBalance: () => { balanceHold = true },
    holdDetails: () => { detailsHold = true }, failSummary: () => { summaryFailed = true },
    invalidateSummary: () => { invalidSummary = true }, dispose: () => provider.dispose(), exchanged, release,
    redirect: () => { redirect = true },
    hold: () => { hold = true },
    initResponse: (value: Record<string, unknown>) => { initOverride = value },
    exchangeResponse: (value: Record<string, unknown>) => { exchangeOverride = value },
    fail: (value: number) => { businessCode = value },
    init: () => init, count: () => count, callback: (state = init.state) => `${init.redirect_uri}?code=test&state=${state}` }
}

it('stores a grant before redirecting, restores account presence, and signs out without deleting device identity', async () => {
  const f = await fixture()
  await f.account.startSignIn('en', f.callbackOrigin, 'desktop')
  await f.wait('waiting-browser')
  expect((await fetch(f.callback('wrong'))).status).toBe(400)
  const response = await fetch(f.callback(), { redirect: 'manual' })
  expect(response.status).toBe(302)
  expect(f.init().client_type).toBe('desktop')
  expect(response.headers.get('location')).toBe(`${f.origin}/dsh/authorized?result=test&locale=zh_CN&client_type=desktop`)
  expect((await f.account.getState()).status).toBe('credential-stored')
  expect(await readFile(join(f.home, 'credentials.yaml'), 'utf8')).toContain('dsh_mock_test')
  expect(await f.account.getPlatformSession()).toEqual({ origin: f.origin, token: 'dsh_mock_test' })
  expect(await f.account.resolveToken('https://api.deepseek.com')).toBeUndefined()
  await f.account.signOut()
  expect((await f.account.getState()).status).toBe('signed-out')
  expect(await f.account.getPlatformSession()).toBeNull()
  expect((await f.ctx.credentials.describeRecord(credentialKey('deepseek-account-platform', 'device'))).configured).toBe(true)
})

it('does not persist a delayed exchange after cancellation or replace the next attempt', async () => {
  const f = await fixture()
  f.exchangeResponse({ user: { email: 'c***@example.invalid', id_profile: { name: 'Cancelled User' } } })
  f.hold()
  await f.account.startSignIn('en', f.callbackOrigin, 'desktop')
  const waiting = await f.wait('waiting-browser')
  const callback = fetch(f.callback(), { redirect: 'manual' }).catch(() => undefined)
  await f.exchanged.promise
  const cancelled = await f.account.cancelSignIn(waiting.attempt!.id)
  expect(cancelled.attempt?.phase).toBe('cancelled')
  await f.account.startSignIn('en', f.callbackOrigin, 'desktop')
  const next = await f.wait('waiting-browser')
  f.release.resolve(undefined)
  await callback
  expect((await f.account.getState()).attempt?.id).toBe(next.attempt?.id)
  expect((await f.account.getState()).status).toBe('signed-out')
  expect(f.count()).toBe(1)
  expect(await f.account.getProfile()).toBeNull()
  await f.account.cancelSignIn(next.attempt!.id)
})

it('allows real account credentials only on the exact official HTTPS origin', async () => {
  const f = await fixture()
  await f.ctx.credentials.modifyRecord(credentialKey('deepseek-account-platform', 'default'), () => Promise.resolve({
    kind: 'grant', payload: { version: 1, issuer: 'https://platform.deepseek.com', token: 'test-account-token' },
  }))
  expect(await f.account.resolveToken('https://api.deepseek.com/v1')).toBe('test-account-token')
  for (const url of ['http://api.deepseek.com', 'https://api.deepseek.com.evil.test', 'https://api.deepseek.com:8443', 'https://user@api.deepseek.com']) {
    expect(await f.account.resolveToken(url)).toBeUndefined()
  }
})

it('restricts platform destinations to the configured origin and route', () => {
  expect(() => platformOrigin('http://localhost:8081', false)).toThrow()
  expect(platformOrigin('http://localhost:8081', true)).toBe('http://localhost:8081')
  expect(() => platformOrigin('http://example.com', true)).toThrow()
  expect(() => browserUrl('https://evil.test/dsh/authorized', 'https://platform.deepseek.com', '/dsh/authorized')).toThrow()
  expect(() => browserUrl('https://platform.deepseek.com/other', 'https://platform.deepseek.com', '/dsh/authorized')).toThrow()
})

it('maps both returned browser pages to the development origin across the login flow', async () => {
  const f = await fixture(undefined, {}, true)
  f.exchangeResponse({ authorized_url: 'https://platform.deepseek.com/dsh/authorized?result=a%2Fb&locale=zh_CN' })
  await f.account.startSignIn('en', f.callbackOrigin, 'desktop')
  expect((await f.wait('waiting-browser')).attempt?.authorizeUrl).toBe(`${f.origin}/dsh/authorize?authorize_id=test`)
  const response = await fetch(f.callback(), { redirect: 'manual' })
  expect(response.status).toBe(302)
  expect(response.headers.get('location')).toBe(`${f.origin}/dsh/authorized?result=a%2Fb&locale=zh_CN&client_type=desktop`)
  expect((await f.account.getState()).status).toBe('credential-stored')
})

it.each([
  ['web', ''],
  ['desktop', ''],
  ['web', '&client_type=desktop&client_type=desktop'],
  ['desktop', '&client_type=web&client_type=web'],
] as const)('redirects the %s login completion with its client type when Platform returns %s', async (client, query) => {
  const f = await fixture()
  f.exchangeResponse({ authorized_url: `${f.origin}/dsh/authorized?result=a%2Fb&locale=zh_CN${query}` })
  await f.account.startSignIn('en', f.callbackOrigin, client)
  await f.wait('waiting-browser')
  const response = await fetch(f.callback(), { redirect: 'manual' })
  expect(response.status).toBe(302)
  expect(response.headers.get('location')).toBe(`${f.origin}/dsh/authorized?result=a%2Fb&locale=zh_CN&client_type=${client}`)
})

it.each([undefined, 'https://other.example/dsh/authorized', '/dsh/authorized'])('rejects an invalid exchange completion URL %s before storing a token', async (authorizedUrl) => {
  const f = await fixture()
  f.exchangeResponse({ authorized_url: authorizedUrl })
  await f.account.startSignIn('en', f.callbackOrigin, 'desktop')
  await f.wait('waiting-browser')
  const response = await fetch(f.callback(), { redirect: 'manual' })
  expect(response.status).toBe(204)
  expect((await f.wait('failed')).status).toBe('signed-out')
  expect((await f.ctx.credentials.describeRecord(credentialKey('deepseek-account-platform', 'default'))).configured).toBe(false)
})

it.each([2, 17])('uses the generic failure for business code %s without guessing product behavior or exposing backend text', async (code) => {
  const f = await fixture()
  f.fail(code)
  await f.account.startSignIn('en', f.callbackOrigin, 'desktop')
  const state = await f.wait('failed')
  expect(state).toMatchObject({ status: 'signed-out', attempt: { phase: 'failed', errorCode: 'protocol' } })
  expect(JSON.stringify(state)).not.toContain('sensitive diagnostic')
})


it('removes its callback route without closing the shared server on disposal', async () => {
  const f = await fixture()
  await f.account.startSignIn('en', f.callbackOrigin, 'desktop')
  await f.wait('waiting-browser')
  const callback = f.callback()
  await f.dispose()
  expect((await fetch(callback)).status).toBe(404)
  await expect(f.account.startSignIn('en', f.callbackOrigin, 'desktop')).rejects.toThrow()
  expect(await f.ctx.credentials.readRecord(credentialKey('deepseek-account-platform', 'default'))).toBeUndefined()
})


it('derives every portal link from the private platform origin', async () => {
  const f = await fixture()
  expect((await f.account.getState()).links).toEqual({ usageUrl: `${f.origin}/usage`, topUpUrl: `${f.origin}/top_up` })
  await f.account.startSignIn('en', f.callbackOrigin, 'desktop')
  expect((await f.wait('waiting-browser')).attempt?.authorizeUrl).toBe(`${f.origin}/dsh/authorize?authorize_id=test`)
})

async function storeAccount(f: Awaited<ReturnType<typeof fixture>>) {
  await f.ctx.credentials.modifyRecord(credentialKey('deepseek-account-platform', 'default'), () => Promise.resolve({
    kind: 'grant', payload: { version: 1, issuer: f.origin, token: 'test-platform-grant' },
  }))
}

it('queries Platform Web endpoints with the stored grant and projects only masked profile and recharge balances', async () => {
  const f = await fixture()
  expect(await readDetails(f.account)).toBeNull()
  await storeAccount(f)
  expect(await readDetails(f.account)).toEqual({
    profile: { status: 'ready', value: { id: 'test-user', name: 'Test Account', avatarUrl: null, contact: '138****5678' } },
    balance: { status: 'ready', value: [{ currency: 'CNY', balance: '123.45' }, { currency: 'USD', balance: '6.78' }] },
  })
  expect(f.detailRequests).toEqual(expect.arrayContaining([
    { path: '/auth-api/v0/users/current', authorization: 'test-platform-grant' },
    { path: '/api/v0/users/get_user_summary', authorization: 'test-platform-grant' },
  ]))
  expect(await f.ctx.credentials.readRecord(credentialKey('deepseek-account-platform', 'default'))).toMatchObject({
    payload: { token: 'test-platform-grant' },
  })
})

it('retains profile data when balance fails instead of reporting a zero balance', async () => {
  const f = await fixture()
  await storeAccount(f)
  f.failSummary()
  expect(await readDetails(f.account)).toMatchObject({ profile: { status: 'ready' }, balance: { status: 'failed' } })
})

it('discards account details when sign-out races the Platform response', async () => {
  const f = await fixture()
  await storeAccount(f)
  f.holdDetails()
  const pending = readDetails(f.account)
  await f.detailsStarted.promise
  await f.account.signOut()
  expect(await pending).toBeNull()
  f.release.resolve(undefined)
  expect(await readDetails(f.account)).toBeNull()
})

it('does not send an account grant to a different configured Platform environment', async () => {
  const f = await fixture()
  await f.ctx.credentials.modifyRecord(credentialKey('deepseek-account-platform', 'default'), () => Promise.resolve({
    kind: 'grant', payload: { version: 1, issuer: 'https://platform.deepseek.com', token: 'test-platform-grant' },
  }))
  await expect(readDetails(f.account)).rejects.toThrow('account: protocol')
  expect(f.detailRequests).toEqual([])
})

it('rejects malformed wallet data independently of the profile response', async () => {
  const f = await fixture()
  await storeAccount(f)
  f.invalidateSummary()
  expect(await readDetails(f.account)).toMatchObject({ profile: { status: 'ready' }, balance: { status: 'failed' } })
})

it.each([
  { input: { email: '', mobile: '138***78' }, expected: '138***78' },
  { input: { email: '', mobile_number: '+86 138••••5678' }, expected: '+86 138••••5678' },
  { input: { email: 'te***@example.invalid' }, expected: 'te***@example.invalid' },
])('preserves Platform contact masking without rewriting it: $expected', async ({ input, expected }) => {
  const f = await fixture(input)
  await storeAccount(f)
  expect((await readDetails(f.account))?.profile).toEqual({
    status: 'ready', value: { id: 'test-user', name: 'Test Account', avatarUrl: null, contact: expected },
  })
})

it('removes the local grant while a shared concurrent logout request is still pending', async () => {
  const f = await fixture()
  await storeAccount(f)
  f.holdLogout()
  await Promise.all([f.account.signOut(), f.account.signOut()])
  await expect.poll(f.logoutCount).toBe(1)
  expect(f.logoutHeaders).toEqual(['test-platform-grant'])
  expect((await f.account.getState()).status).toBe('signed-out')
  await f.account.signOut()
  expect(f.logoutCount()).toBe(1)
})

it('bounds failed logout retries without restoring the grant or deleting a new login', async () => {
  const f = await fixture()
  await storeAccount(f)
  f.failLogout(true)
  await expect(f.account.signOut()).resolves.toMatchObject({ status: 'signed-out' })
  expect(await readDetails(f.account)).toBeNull()
  await f.account.startSignIn('en', f.callbackOrigin, 'desktop')
  await f.wait('waiting-browser')
  f.exchangeResponse({ token: 'new-account-token' })
  await fetch(f.callback(), { redirect: 'manual' })
  await expect.poll(f.logoutCount).toBe(6)
  expect(f.logoutHeaders).toEqual(Array<string>(6).fill('test-platform-grant'))
  expect((await f.account.getState()).status).toBe('credential-stored')
  expect(await f.ctx.credentials.readRecord(credentialKey('deepseek-account-platform', 'default')))
    .toMatchObject({ kind: 'grant', payload: { token: 'new-account-token' } })
})

it.each([['en', 'en_US'], ['zh-CN', 'zh_CN']])('passes %s to Platform and keeps the active attempt language', async (locale, platformLocale) => {
  const f = await fixture()
  await f.account.startSignIn(locale, f.callbackOrigin, 'desktop')
  const first = await f.wait('waiting-browser')
  expect(f.init().locale).toBe(platformLocale)
  expect((await f.account.startSignIn('zh', f.callbackOrigin, 'desktop')).attempt?.id).toBe(first.attempt?.id)
  expect(f.init().locale).toBe(platformLocale)
  await f.account.cancelSignIn(first.attempt!.id)
  await f.account.startSignIn('zh', f.callbackOrigin, 'desktop')
  await f.wait('waiting-browser')
  expect(f.init().locale).toBe('zh_CN')
})

it('adds private deployment cookies to every Platform request without exposing them in account state', async () => {
  const f = await fixture(undefined, { Cookie: 'test_gate=synthetic' })
  await f.account.startSignIn('en', f.callbackOrigin, 'desktop')
  await f.wait('waiting-browser')
  await fetch(f.callback(), { redirect: 'manual' })
  await readDetails(f.account)
  expect(JSON.stringify(await f.account.getState())).not.toContain('test_gate')
  await f.account.signOut()
  await expect.poll(f.logoutCount).toBe(1)
  expect(f.receivedHeaders.map(item => item.path)).toEqual([
    '/auth-api/v0/dsh/auth_init', '/auth-api/v0/dsh/auth_exchange',
    '/auth-api/v0/users/current', '/api/v0/users/get_user_summary', '/auth-api/v0/users/logout',
  ])
  expect(f.receivedHeaders.every(item => item.cookie === 'test_gate=synthetic')).toBe(true)
  expect(f.receivedHeaders.slice(2).every(item => item.authorization === 'dsh_mock_test')).toBe(true)
})

it('rejects reserved, duplicate and malformed deployment headers without disclosing values', () => {
  for (const headers of [
    { Authorization: 'secret-value' }, { 'X-DSH-Auth-Token': 'secret-value' }, { HOST: 'secret-value' }, { 'Content-Length': '5' },
    { Cookie: 'secret-value', cookie: 'other' }, { 'bad name': 'secret-value' },
    { Cookie: 'secret-value\r\ninjected: x' },
  ]) {
    expect(() => platformHeaders(headers)).toThrow(/^account: requestHeaders/)
  }
  expect(platformHeaders({ Cookie: 'test_gate=synthetic' })).toEqual({ cookie: 'test_gate=synthetic' })
})

it('does not forward deployment cookies through a Platform redirect', async () => {
  const f = await fixture(undefined, { Cookie: 'test_gate=synthetic' })
  f.redirect()
  await f.account.startSignIn('en', f.callbackOrigin, 'desktop')
  await f.wait('failed')
  expect(f.receivedHeaders.map(item => item.path)).toEqual(['/auth-api/v0/dsh/auth_init'])
})

it('closes the failed Web authorization tab without redirecting and keeps the shared HTTP server alive', async () => {
  const f = await fixture()
  const dispose = f.ctx.webServer.register({ kind: 'exact', path: '/health', handler: (_req, res) => { res.end('alive') } })
  cleanups.push(async () => { dispose() })
  await f.account.startSignIn('en', f.callbackOrigin, 'web')
  await f.wait('waiting-browser')
  expect(new URL(f.init().redirect_uri!).origin).toBe(f.callbackOrigin)
  f.fail(17)
  const response = await fetch(f.callback(), { redirect: 'manual' })
  expect(response.status).toBe(200)
  expect(response.headers.get('location')).toBeNull()
  const page = await response.text()
  expect(page).toContain('window.close()')
  const nonce = /nonce="([^"]+)"/.exec(page)![1]
  expect(response.headers.get('content-security-policy')).toContain(`script-src 'nonce-${nonce}'`)
  await expect(`${page.match(/<p>(.*?)<\/p>/)![1]}\n`)
    .toMatchFileSnapshot('./expected/web-exchange-failure.txt')
  expect(f.init().client_type).toBe('web')
  expect(await f.wait('failed')).toMatchObject({ status: 'signed-out', attempt: { errorCode: 'protocol' } })
  expect(f.count()).toBe(1)
  expect(await (await fetch(`${f.callbackOrigin}/health`)).text()).toBe('alive')
  f.fail(0)
  await f.account.startSignIn('en', f.callbackOrigin, 'web')
  await f.wait('waiting-browser')
  const success = await fetch(f.callback(), { redirect: 'manual' })
  expect(success.headers.get('location')).toBe(`${f.origin}/dsh/authorized?result=test&locale=zh_CN&client_type=web`)
  expect(f.count()).toBe(2)
})

it('completes login through a local TCP forward using the browser port rather than the Host port', async () => {
  const f = await fixture()
  const sockets = new Set<Socket>()
  const forward = createTcpServer((socket) => {
    const upstream = connect(f.ctx.webServer.port, '127.0.0.1')
    for (const connection of [socket, upstream]) {
      sockets.add(connection)
      connection.on('close', () => { sockets.delete(connection) })
      connection.on('error', () => { socket.destroy(); upstream.destroy() })
    }
    socket.pipe(upstream).pipe(socket)
  })
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>(resolve => forward.close(() => { resolve() }))
  })
  await new Promise<void>(resolve => forward.listen(0, '127.0.0.1', resolve))
  const address = forward.address()
  if (address === null || typeof address === 'string') throw new Error('missing forward listener')
  const forwardedOrigin = `http://127.0.0.1:${address.port}`
  expect(forwardedOrigin).not.toBe(f.callbackOrigin)
  await f.account.startSignIn('en', forwardedOrigin, 'web')
  await f.wait('waiting-browser')
  expect(f.init().redirect_uri).toBe(`${forwardedOrigin}/oauth/callback`)
  const response = await fetch(f.callback(), { redirect: 'manual' })
  expect(response.headers.get('location')).toBe(`${f.origin}/dsh/authorized?result=test&locale=zh_CN&client_type=web`)
  expect((await f.account.getState()).status).toBe('credential-stored')
})

it('keeps cancellation authoritative without reopening WebUI after a delayed exchange', async () => {
  const f = await fixture()
  f.hold()
  await f.account.startSignIn('en', f.callbackOrigin, 'web')
  const state = await f.wait('waiting-browser')
  const response = fetch(f.callback(), { redirect: 'manual' })
  await f.exchanged.promise
  await f.account.cancelSignIn(state.attempt!.id)
  expect((await response).status).toBe(204)
  f.release.resolve(undefined)
  expect(await f.account.getState()).toMatchObject({ status: 'signed-out', attempt: { phase: 'cancelled' } })
})

it.each(['https://example.com', 'http://example.com', 'http://127.0.0.1.evil.test',
  'http://localhost', 'http://127.0.0.1', 'http://[::1]', 'http://localhost:0', 'http://localhost:65536',
  'http://user@localhost', 'http://localhost/path', 'http://localhost/?x=1', 'http://localhost/#x', 'invalid'])
('rejects unsupported callback origin %s before starting authorization', async (origin) => {
  const f = await fixture()
  await expect(f.account.startSignIn('en', origin, 'web')).rejects.toThrow('account: protocol')
  expect(f.init()).toEqual({})
})

it('normalizes supported loopback callback origins', () => {
  expect(loginOrigin('http://localhost:8080/')).toBe('http://localhost:8080')
  expect(loginOrigin('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080')
  expect(loginOrigin('http://[::1]:8080/')).toBe('http://[::1]:8080')
  expect(loginOrigin('http://localhost:80')).toBe('http://localhost:80')
})

it('cancels remotely with the original PKCE verifier without waiting for acknowledgment', async () => {
  const f = await fixture()
  f.holdCancel()
  await f.account.startSignIn('en', f.callbackOrigin, 'web')
  const state = await f.wait('waiting-browser')
  expect((await f.account.cancelSignIn(state.attempt!.id)).attempt?.phase).toBe('cancelled')
  await f.cancellationReceived.promise
  expect(f.cancellations).toHaveLength(1)
  const body = f.cancellations[0]!
  expect(Object.keys(body).sort()).toEqual(['authorize_id', 'code_verifier'])
  expect(body.authorize_id).toBe('test')
  expect(createHash('sha256').update(body.code_verifier!).digest('base64url')).toBe(f.init().code_challenge)
  expect(f.receivedHeaders.find(row => row.path?.endsWith('auth_cancel'))?.authorization).toBeUndefined()
  await f.account.cancelSignIn(state.attempt!.id)
  expect(f.cancellations).toHaveLength(1)
  f.fail(1)
  f.release.resolve(undefined)
  expect(await f.account.getState()).toMatchObject({ status: 'signed-out', attempt: { phase: 'cancelled' } })
})

it('preserves localhost and the browser-visible port in authorization initialization', async () => {
  const f = await fixture()
  const origin = f.callbackOrigin.replace('127.0.0.1', 'localhost')
  await f.account.startSignIn('en', origin, 'web')
  const state = await f.wait('waiting-browser')
  expect(f.init().redirect_uri).toBe(`${origin}/oauth/callback`)
  await f.account.cancelSignIn(state.attempt!.id)
})

it('never exports an embedded Platform token to a different configured issuer', async () => {
  const f = await fixture()
  await f.ctx.credentials.modifyRecord(credentialKey('deepseek-account-platform', 'default'), () => Promise.resolve({
    kind: 'grant', payload: { version: 1, token: 'fixture-secret', issuer: 'https://platform.deepseek.com' },
  }))
  await expect(f.account.getPlatformSession()).rejects.toThrow()
})

async function readDetails(account: Pick<PlatformAccount, 'getProfile' | 'getBalance'>) {
  const [profile, balance] = await Promise.all([account.getProfile(), account.getBalance()])
  return profile === null || balance === null ? null : { profile, balance }
}

it('returns the profile while the balance request is still pending', async () => {
  const f = await fixture()
  await storeAccount(f)
  f.holdBalance()
  let balanceSettled = false
  const balance = f.account.getBalance().then((value) => { balanceSettled = true; return value })
  try {
    await f.detailsStarted.promise
    expect(await f.account.getProfile()).toMatchObject({ status: 'ready', value: { name: 'Test Account' } })
    expect(balanceSettled).toBe(false)
  } finally { f.release.resolve(undefined) }
  expect(await balance).toMatchObject({ status: 'ready' })
})


it('uses exchange user for the first profile read and fetches current on refresh', async () => {
  const f = await fixture()
  f.exchangeResponse({ user: { id: 'exchange-user', email: 'e***@example.invalid', id_profile: { name: 'Exchange User' }, token: 'discard-me' } })
  await f.account.startSignIn('en', f.callbackOrigin, 'desktop')
  await f.wait('waiting-browser')
  await fetch(f.callback(), { redirect: 'manual' })
  expect(await f.account.getProfile()).toMatchInlineSnapshot(`
    {
      "status": "ready",
      "value": {
        "avatarUrl": null,
        "contact": "e***@example.invalid",
        "id": "exchange-user",
        "name": "Exchange User",
      },
    }
  `)
  expect(f.detailRequests).toEqual([])
  expect((await f.account.getProfile())).toMatchObject({ status: 'ready', value: { name: 'Test Account' } })
  expect(f.detailRequests).toHaveLength(1)
  expect(await readFile(join(f.home, 'credentials.yaml'), 'utf8')).not.toContain('discard-me')
})

it.each([undefined, null, { email: 123 }])('fetches current when exchange user is unavailable: %j', async (user) => {
  const f = await fixture()
  f.exchangeResponse({ user })
  await f.account.startSignIn('en', f.callbackOrigin, 'desktop')
  await f.wait('waiting-browser')
  await fetch(f.callback(), { redirect: 'manual' })
  expect(await f.account.getProfile()).toMatchObject({ status: 'ready', value: { name: 'Test Account' } })
  expect(f.detailRequests).toHaveLength(1)
})


it('uses the initialization payload ID for cancellation without extracting it from the browser URL', async () => {
  const f = await fixture()
  f.initResponse({ authorize_id: 'payload-id', authorize_url: `${f.origin}/dsh/authorize?opaque=value` })
  await f.account.startSignIn('en', f.callbackOrigin, 'desktop')
  const state = await f.wait('waiting-browser')
  await f.account.cancelSignIn(state.attempt!.id)
  await f.cancellationReceived.promise
  expect(f.cancellations[0]?.authorize_id).toBe('payload-id')
})

it.each([undefined, '', 123])('rejects an invalid initialization authorize_id: %j', async (authorizeId) => {
  const f = await fixture()
  f.initResponse({ authorize_id: authorizeId })
  await f.account.startSignIn('en', f.callbackOrigin, 'desktop')
  expect(await f.wait('failed')).toMatchObject({ status: 'signed-out', attempt: { errorCode: 'protocol' } })
  expect(f.count()).toBe(0)
})


it('overlays account cookies without changing authorization or logout routing', async () => {
  const f = await fixture(undefined, { Cookie: 'gate=private; route=auth', 'x-private': 'keep' }, false, { Cookie: 'route=account' })
  await f.account.startSignIn('en', f.callbackOrigin, 'desktop')
  await f.wait('waiting-browser')
  await fetch(f.callback(), { redirect: 'manual' })
  await readDetails(f.account)
  expect(await f.account.getPlatformSession()).toMatchObject({ requestHeaders: { cookie: 'gate=private; route=account', 'x-private': 'keep' } })
  await f.account.signOut()
  await expect.poll(f.logoutCount).toBe(1)
  for (const row of f.receivedHeaders) {
    const detail = ['/auth-api/v0/users/current', '/api/v0/users/get_user_summary'].includes(row.path ?? '')
    expect(row.cookie).toBe(detail ? 'gate=private; route=account' : 'gate=private; route=auth')
  }
  expect(JSON.stringify(await f.account.getState())).not.toContain('private')
})


it('sends a development grant only to its configured inference origin', async () => {
  const f = await fixture(undefined, {}, false, {}, 'http://inference.example.test:8094')
  f.exchangeResponse({ token: 'test-account-token' })
  await f.account.startSignIn('en', f.callbackOrigin, 'desktop')
  await f.wait('waiting-browser')
  await fetch(f.callback(), { redirect: 'manual' })
  await f.wait('succeeded')
  expect(await f.account.resolveToken('http://inference.example.test:8094/api')).toBe('test-account-token')
  for (const url of ['https://api.deepseek.com', 'http://inference.example.test:8095/api',
    'https://inference.example.test:8094/api', 'http://user@inference.example.test:8094/api']) {
    expect(await f.account.resolveToken(url)).toBeUndefined()
  }
})


it('starts signed out after discarding another Platform issuer without remote logout or unrelated credential loss', async () => {
  const accountKey = credentialKey('deepseek-account-platform', 'default')
  const deviceKey = credentialKey('deepseek-account-platform', 'device')
  const apiKey = credentialRef('TEST_PLATFORM_SWITCH_API_KEY')
  const f = await fixture(undefined, {}, false, {}, undefined, async (ctx) => {
    await ctx.credentials.modifyRecord(accountKey, () => Promise.resolve({
      kind: 'grant', payload: { version: 1, issuer: 'https://old-platform.example.test', token: 'old-token' },
    }))
    await ctx.credentials.modifyRecord(deviceKey, () => Promise.resolve({ kind: 'grant', payload: { id: 'stable-device' } }))
    await ctx.credentials.set(apiKey, 'retained-api-key')
  })
  expect((await f.account.getState()).status).toBe('signed-out')
  expect(await f.account.getPlatformSession()).toBeNull()
  expect(await f.account.getProfile()).toBeNull()
  expect(await f.account.getBalance()).toBeNull()
  expect(await f.ctx.credentials.readRecord(accountKey)).toBeUndefined()
  expect(await f.ctx.credentials.readRecord(deviceKey)).toEqual({ kind: 'grant', payload: { id: 'stable-device' } })
  expect((await f.ctx.credentials.resolve(apiKey))?.value).toBe('retained-api-key')
  expect(f.receivedHeaders).toEqual([])
})

it('preserves a matching issuer and its grant when a balance request fails', async () => {
  const accountKey = credentialKey('deepseek-account-platform', 'default')
  const f = await fixture(undefined, {}, false, {}, undefined, async (ctx, issuer) => {
    await ctx.credentials.modifyRecord(accountKey, () => Promise.resolve({
      kind: 'grant', payload: { version: 1, issuer, token: 'retained-token' },
    }))
  })
  f.failSummary()
  expect(await f.account.getBalance()).toEqual({ status: 'failed' })
  expect((await f.account.getState()).status).toBe('credential-stored')
  expect(await f.ctx.credentials.readRecord(accountKey)).toMatchObject({ kind: 'grant', payload: { token: 'retained-token' } })
  expect(f.logoutCount()).toBe(0)
})

it('carries the configured embedded frontend selector in the private Platform session', async () => {
  const f = await fixture(undefined, {}, false, {}, undefined, undefined, 'feat/test')
  await f.account.startSignIn('en', f.callbackOrigin, 'desktop')
  await f.wait('waiting-browser')
  await fetch(f.callback(), { redirect: 'manual' })
  expect(await f.account.getPlatformSession()).toEqual({ origin: f.origin, token: 'dsh_mock_test', embeddedPageDist: 'feat/test' })
})

it.each([
  ['darwin', 'desktop-mac'], ['win32', 'desktop-win'], [null, undefined],
] as const)('identifies %s Host API requests without changing embedded page headers', async (desktopPlatform, expected) => {
  const f = await fixture(undefined, { Cookie: 'test_gate=synthetic' }, false, {}, undefined, undefined, '', desktopPlatform)
  await f.account.startSignIn('en', f.callbackOrigin, 'desktop')
  await f.wait('waiting-browser')
  const attempt = (await f.account.getState()).attempt!
  await f.account.cancelSignIn(attempt.id)
  await f.cancellationReceived.promise
  await f.account.startSignIn('en', f.callbackOrigin, 'desktop')
  await f.wait('waiting-browser')
  await fetch(f.callback(), { redirect: 'manual' })
  await readDetails(f.account)
  expect(await f.account.getPlatformSession()).toMatchObject({ requestHeaders: { cookie: 'test_gate=synthetic' } })
  expect((await f.account.getPlatformSession())?.requestHeaders).not.toHaveProperty('x-client-platform')
  await f.account.signOut()
  await expect.poll(f.logoutCount).toBe(1)
  expect(f.receivedHeaders.map(item => item.path)).toEqual([
    '/auth-api/v0/dsh/auth_init', '/auth-api/v0/dsh/auth_cancel',
    '/auth-api/v0/dsh/auth_init', '/auth-api/v0/dsh/auth_exchange',
    '/auth-api/v0/users/current', '/api/v0/users/get_user_summary', '/auth-api/v0/users/logout',
  ])
  expect(f.receivedHeaders.map(item => item.clientPlatform)).toEqual(f.receivedHeaders.map(() => expected))
})

it('rejects unsupported native desktop platforms in configuration', () => {
  // @ts-expect-error Configuration files can name unsupported operating systems.
  expect(() => Config({ desktopPlatform: 'linux' })).toThrow()
})

it('retains successful profile data on current failure only for the same credential', async () => {
  const f = await fixture()
  f.exchangeResponse({ user: { email: 'e***@example.invalid', id_profile: { name: 'Exchange User' } } })
  await f.account.startSignIn('en', f.callbackOrigin, 'desktop')
  await f.wait('waiting-browser')
  await fetch(f.callback(), { redirect: 'manual' })
  const initial = await f.account.getProfile()
  expect(initial).toMatchObject({ status: 'ready', value: { name: 'Exchange User' } })
  f.failProfile(true)
  expect(await f.account.getProfile()).toEqual(initial)
  f.failProfile(false)
  const refreshed = await f.account.getProfile()
  expect(refreshed).toMatchObject({ status: 'ready', value: { name: 'Test Account' } })
  f.failProfile(true)
  expect(await f.account.getProfile()).toEqual(refreshed)
  const key = credentialKey('deepseek-account-platform', 'default')
  await f.ctx.credentials.modifyRecord(key, () => Promise.resolve({
    kind: 'grant', payload: { version: 1, issuer: f.origin, token: 'replacement-token' },
  }))
  expect(await f.account.getProfile()).toEqual({ status: 'failed' })
  await f.account.signOut()
  expect(await f.account.getProfile()).toBeNull()
})
