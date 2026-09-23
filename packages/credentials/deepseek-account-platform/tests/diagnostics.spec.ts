import { inspect } from 'node:util'
import { expect, it, vi, type MockInstance } from 'vitest'
import { browserUrl, requestAccount, requestPlatform, requestUnnotifiedBonuses } from '../src/protocol.ts'

/** Render mocked diagnostics as plain JavaScript so assertions read logged values, not JSON escapes. */
function diagnostics(output: MockInstance<typeof console.info>): string {
  return output.mock.calls
    .map(call => call.map(part => typeof part === 'string' ? part : inspect(part, { depth: 6 })).join(' '))
    .join('\n')
}

it.each(['/dsh/authorize', '/dsh/authorized'])('maps %s to the configured development origin and preserves query bytes', (path) => {
  const origin = 'http://localhost:8081'
  const query = '?authorize_id=fixture&value=a%2Fb&value=two+words&empty='
  const url = `https://platform.deepseek.com${path}${query}`
  expect(() => browserUrl(url, origin, path)).toThrow()
  expect(browserUrl(url, origin, path, true)).toBe(`${origin}${path}${query}`)
  expect(browserUrl(`${origin}${path}${query}`, origin, path, true)).toBe(`${origin}${path}${query}`)
  for (const invalid of [
    `http://other.example${path}`,
    'javascript:alert(1)',
    'https://platform.deepseek.com/other',
    `https://user:password@platform.deepseek.com${path}`,
    `https://platform.deepseek.com${path}#fragment`,
  ]) expect(() => browserUrl(invalid, origin, path, true)).toThrow()
})

it('reports business failure codes and the response body without credentials', async () => {
  const output = vi.spyOn(console, 'info').mockImplementation(() => undefined)
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
    code: 0, data: { biz_code: 40123, biz_data: { token: 'response-secret' } }, message: 'private-message',
  })))
  try {
    await expect(requestPlatform('https://platform.deepseek.com', 'auth_init',
      { code_verifier: 'request-secret' }, new AbortController().signal,
      { Cookie: 'cookie-secret' })).rejects.toThrow('account: protocol')
    const logged = JSON.stringify(output.mock.calls)
    expect(logged).toContain('/auth-api/v0/dsh/auth_init')
    expect(logged).toContain('40123')
    expect(logged).toContain('200')
    expect(logged).toContain('private-message')
    for (const secret of ['response-secret', 'request-secret', 'cookie-secret']) {
      expect(logged).not.toContain(secret)
    }
  } finally {
    fetcher.mockRestore()
    output.mockRestore()
  }
})

it('reports the HTTP status, stable code and sanitized JSON failure body', async () => {
  const output = vi.spyOn(console, 'info').mockImplementation(() => undefined)
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
    detail: 'server exploded', token: 'secret-token', cookie: 'secret-cookie', code: 7, data: null,
  }), { status: 500 }))
  try {
    await expect(requestPlatform('https://platform.deepseek.com', 'auth_exchange',
      {}, new AbortController().signal, {})).rejects.toThrow('account: network')
    const logged = diagnostics(output)
    expect(logged).toContain('500')
    expect(logged).toContain('network')
    expect(logged).toContain('server exploded')
    expect(logged).toContain('"code":7')
    for (const secret of ['secret-token', 'secret-cookie']) expect(logged).not.toContain(secret)
  } finally {
    fetcher.mockRestore()
    output.mockRestore()
  }
})

it('keeps numeric codes and redacts string credentials, authorize ids and API keys', async () => {
  const output = vi.spyOn(console, 'info').mockImplementation(() => undefined)
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
    code: 1, msg: 'BONUS_ORDER_NOT_FOUND', data: null, authorize_id: 'authorize-secret',
    api_key: 'api-key-secret', redirect_uri: 'https://platform.deepseek.com/dsh/authorized?token=x',
  }), { status: 500 }))
  try {
    await expect(requestPlatform('https://platform.deepseek.com', 'auth_exchange',
      {}, new AbortController().signal, {})).rejects.toThrow('account: network')
    const logged = diagnostics(output)
    expect(logged).toContain('"code":1')
    expect(logged).toContain('"data":null')
    expect(logged).toContain('BONUS_ORDER_NOT_FOUND')
    for (const secret of ['authorize-secret', 'api-key-secret']) expect(logged).not.toContain(secret)
    expect(logged).toContain('[authorize-url]')
  } finally {
    fetcher.mockRestore()
    output.mockRestore()
  }
})

it('reports a non-JSON HTTP failure body and its validation detail', async () => {
  const output = vi.spyOn(console, 'info').mockImplementation(() => undefined)
  const fetcher = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(new Response('upstream is down', { status: 502, statusText: 'Bad Gateway' }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ detail: [{ loc: ['header', 'x-client-platform'] }] }), { status: 422 }))
  try {
    await expect(requestPlatform('https://platform.deepseek.com', 'auth_exchange',
      {}, new AbortController().signal, {})).rejects.toThrow('account: network')
    await expect(requestPlatform('https://platform.deepseek.com', 'auth_exchange',
      {}, new AbortController().signal, {})).rejects.toThrow('account: network')
    const logged = JSON.stringify(output.mock.calls)
    expect(logged).toContain('502')
    expect(logged).toContain('upstream is down')
    expect(logged).toContain('422')
    expect(logged).toContain('x-client-platform')
  } finally {
    fetcher.mockRestore()
    output.mockRestore()
  }
})

it('redacts request secrets and authorization URLs echoed into a failure body', async () => {
  const output = vi.spyOn(console, 'info').mockImplementation(() => undefined)
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
    'verifier verifier-secret echoed for https://platform.deepseek.com/dsh/authorize?code=private-code and cookie-secret',
    { status: 500 }))
  try {
    await expect(requestPlatform('https://platform.deepseek.com', 'auth_exchange',
      { code_verifier: 'verifier-secret', code: 'private-code' }, new AbortController().signal,
      { Cookie: 'cookie-secret' })).rejects.toThrow('account: network')
    const logged = diagnostics(output)
    expect(logged).toContain('verifier [redacted] echoed')
    for (const secret of ['verifier-secret', 'private-code', 'cookie-secret', '/dsh/authorize']) {
      expect(logged).not.toContain(secret)
    }
    expect(logged).toContain('[redacted]')
    expect(logged).toContain('[authorize-url]')
  } finally {
    fetcher.mockRestore()
    output.mockRestore()
  }
})

it('redacts one echoed cookie component even when the whole cookie value is not repeated', async () => {
  const output = vi.spyOn(console, 'info').mockImplementation(() => undefined)
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response('request carried abcdef123456 without the cookie name', { status: 500 }))
  try {
    await expect(requestPlatform('https://platform.deepseek.com', 'auth_exchange',
      {}, new AbortController().signal, { Cookie: 'session_id=abcdef123456' })).rejects.toThrow('account: network')
    const logged = diagnostics(output)
    expect(logged).toContain('request carried [redacted] without the cookie name')
    expect(logged).not.toContain('abcdef123456')
  } finally {
    fetcher.mockRestore()
    output.mockRestore()
  }
})

it('keeps numeric codes readable when a short cookie value also appears in the body', async () => {
  const output = vi.spyOn(console, 'info').mockImplementation(() => undefined)
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response('{"code":1,"msg":"DECODE_FAILED"}', { status: 500 }))
  try {
    await expect(requestPlatform('https://platform.deepseek.com', 'auth_exchange',
      {}, new AbortController().signal, { Cookie: 'a=1' })).rejects.toThrow('account: network')
    const logged = diagnostics(output)
    expect(logged).toContain('"code":1')
    expect(logged).toContain('DECODE_FAILED')
  } finally {
    fetcher.mockRestore()
    output.mockRestore()
  }
})


it('logs a validated success body with tokens, authorize ids and authorization URLs redacted', async () => {
  const output = vi.spyOn(console, 'info').mockImplementation(() => undefined)
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
    code: 0, msg: 'ok', data: { biz_code: 0, biz_data: {
      token: 'token-value-secret', authorize_id: 'authorize-secret',
      authorized_url: 'https://platform.deepseek.com/dsh/authorized', expires_in: 600,
    } },
  })))
  try {
    await expect(requestPlatform('https://platform.deepseek.com', 'auth_exchange',
      { code_verifier: 'verifier-secret' }, new AbortController().signal, {})).resolves.toMatchObject({
      token: 'token-value-secret',
    })
    const logged = diagnostics(output)
    expect(logged).toContain('[deepseek-account] response body')
    expect(logged).toContain('200')
    expect(logged).toContain('"expires_in":600')
    expect(logged).toContain('"msg":"ok"')
    expect(logged).toContain('[redacted]')
    for (const secret of ['token-value-secret', 'authorize-secret', 'verifier-secret',
      'https://platform.deepseek.com/dsh/authorized']) {
      expect(logged).not.toContain(secret)
    }
  } finally {
    fetcher.mockRestore()
    output.mockRestore()
  }
})

it.each([
  ['requestUnnotifiedBonuses', () => requestUnnotifiedBonuses(
    'https://platform.deepseek.com', 'grant-token-secret', new AbortController().signal, {})],
  ['requestAccount', () => requestAccount(
    'https://platform.deepseek.com', '/api/v0/users/get_user_summary',
    'grant-token-secret', new AbortController().signal, {})],
])('logs the %s success body without the grant echoed into it', async (_name, call) => {
  const output = vi.spyOn(console, 'info').mockImplementation(() => undefined)
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
    code: 0, data: { biz_code: 0, biz_data: [
      { order_id: 'fixture-order', amount: '5.00', currency: 'CNY', note: 'grant-token-secret' },
    ] },
  })))
  try {
    await call()
    const logged = diagnostics(output)
    expect(logged).toContain('[deepseek-account] response body')
    expect(logged).toContain('fixture-order')
    expect(logged).toContain('"amount":"5.00"')
    expect(logged).not.toContain('grant-token-secret')
    expect(logged).toContain('[redacted]')
  } finally {
    fetcher.mockRestore()
    output.mockRestore()
  }
})

it('never labels a nonzero business code as a successful response body', async () => {
  const output = vi.spyOn(console, 'info').mockImplementation(() => undefined)
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
    code: 0, data: { biz_code: 1, biz_msg: 'BONUS_ORDER_NOT_FOUND', biz_data: null },
  })))
  try {
    await expect(requestPlatform('https://platform.deepseek.com', 'ack_bonus_notified', {
      order_id: '4c1b0000-0000-4000-8000-000000000000',
    }, new AbortController().signal, {})).rejects.toThrow('account: protocol')
    const logged = diagnostics(output)
    expect(logged).toContain('business rejected')
    expect(logged).not.toContain('response body')
  } finally {
    fetcher.mockRestore()
    output.mockRestore()
  }
})

it('logs a validated success body with its credential-named fields replaced', async () => {
  const output = vi.spyOn(console, 'info').mockImplementation(() => undefined)
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
    code: 0, data: { biz_code: 0, biz_data: {
      id: 'test-user', token: 'never-copy-response-token',
      id_profile: { name: 'Test Account', picture: null },
    } },
  })))
  try {
    await expect(requestPlatform('https://platform.deepseek.com', 'auth_init', {},
      new AbortController().signal, {})).resolves.toMatchObject({ id: 'test-user' })
    const logged = diagnostics(output)
    expect(logged).toContain('Test Account')
    expect(logged).toContain('"token":"[redacted]"')
    expect(logged).not.toContain('never-copy-response-token')
  } finally {
    fetcher.mockRestore()
    output.mockRestore()
  }
})

it('truncates an oversized validated success body at the log limit', async () => {
  const output = vi.spyOn(console, 'info').mockImplementation(() => undefined)
  const overflow = 'y'.repeat(4_096)
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
    code: 0, data: { biz_code: 0, biz_data: { message: overflow } },
  })))
  try {
    await expect(requestPlatform('https://platform.deepseek.com', 'auth_init', {},
      new AbortController().signal, {})).resolves.toMatchObject({ message: overflow })
    const logged = diagnostics(output)
    expect(logged).toContain('…')
    expect(logged).not.toContain('y'.repeat(2_049))
  } finally {
    fetcher.mockRestore()
    output.mockRestore()
  }
})

/** Matches the `at` field of one rendered diagnostic as serialized JSON. */
const ISO_TIMESTAMP = /"at":"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z"/

it('stamps every diagnostic with the same ISO UTC timestamp field', async () => {
  const output = vi.spyOn(console, 'info').mockImplementation(() => undefined)
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
    code: 0, data: { biz_code: 0, biz_data: { ok: true } },
  })))
  try {
    await requestPlatform('https://platform.deepseek.com', 'auth_init', {},
      new AbortController().signal, {})
    expect(output.mock.calls.length).toBeGreaterThan(1)
    for (const call of output.mock.calls) {
      expect(call[0]).toMatch(/^\[deepseek-account\] /)
      expect(JSON.stringify(call[1])).toMatch(ISO_TIMESTAMP)
    }
    expect(diagnostics(output)).toContain('response body')
  } finally {
    fetcher.mockRestore()
    output.mockRestore()
  }
})

it('leaves dates and amounts readable when a cookie routing flag is one character', async () => {
  // The reported case: a deployment flag cookie whose value is `1` must not turn every digit in a
  // server-authored date or amount into a redaction.
  const output = vi.spyOn(console, 'info').mockImplementation(() => undefined)
  const bonus = {
    order_id: '4c1b0000-0000-4000-8000-000000000000', amount: '1.50', currency: 'CNY',
    granted_at: '2026-09-21T12:00:00Z', expires_at: '2026-10-21T12:00:00Z',
    msg: '已赠送您 1.50 元 DSH 体验赠金，2026-10-21 到期。',
  }
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
    code: 0, data: { biz_code: 0, biz_data: [bonus] },
  })))
  try {
    await requestUnnotifiedBonuses('https://platform.deepseek.com', 'grant-token-secret',
      new AbortController().signal, {
        cookie: 'platform_target_env_port=20022; _ds_d28ddae08ee24f90c1b0cb9d912757e2=1',
      })
    const logged = diagnostics(output)
    expect(logged).toContain('"granted_at":"2026-09-21T12:00:00Z"')
    expect(logged).toContain('"expires_at":"2026-10-21T12:00:00Z"')
    expect(logged).toContain('"amount":"1.50"')
    expect(logged).toContain('已赠送您 1.50 元 DSH 体验赠金，2026-10-21 到期。')
    expect(logged).not.toContain('[redacted]')
    expect(logged).not.toContain('grant-token-secret')
  } finally {
    fetcher.mockRestore()
    output.mockRestore()
  }
})

it('still redacts a short request-body credential wherever it appears', async () => {
  // Only a deployment cookie value is restricted to whole-value matches; a real secret from the
  // request body keeps replacing its text wherever an echoed body repeats it.
  const output = vi.spyOn(console, 'info').mockImplementation(() => undefined)
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
    code: 0, data: { biz_code: 0, biz_data: { note: 'carried a1b2c at 2026-10-21' } },
  })))
  try {
    await requestPlatform('https://platform.deepseek.com', 'auth_init',
      { code_verifier: 'a1b2c' }, new AbortController().signal, {})
    const logged = diagnostics(output)
    expect(logged).toContain('carried [redacted] at 2026-10-21')
    expect(logged).not.toContain('a1b2c')
  } finally {
    fetcher.mockRestore()
    output.mockRestore()
  }
})

it('still redacts a short authorization header value wherever it appears', async () => {
  const output = vi.spyOn(console, 'info').mockImplementation(() => undefined)
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
    code: 0, data: { biz_code: 0, biz_data: { note: 'rejected grant ab12cd for 2026-10-21' } },
  })))
  try {
    await requestAccount('https://platform.deepseek.com', '/auth-api/v0/users/current', 'ab12cd',
      new AbortController().signal, {})
    const logged = diagnostics(output)
    expect(logged).toContain('rejected grant [redacted] for 2026-10-21')
    expect(logged).not.toContain('ab12cd')
  } finally {
    fetcher.mockRestore()
    output.mockRestore()
  }
})

it('keeps a real secret a substring match even when a short cookie value matches it', async () => {
  // The cookie flag alone is exact-only, but the same text arriving as a request credential must
  // still redact wherever it appears.
  const output = vi.spyOn(console, 'info').mockImplementation(() => undefined)
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
    code: 0, data: { biz_code: 0, biz_data: { note: 'carried 1 at 2026-10-21 for 1.50' } },
  })))
  try {
    await requestPlatform('https://platform.deepseek.com', 'auth_init',
      { code_verifier: '1' }, new AbortController().signal,
      { cookie: '_ds_d28ddae08ee24f90c1b0cb9d912757e2=1' })
    const logged = diagnostics(output)
    // A real credential stays a substring match, so it wins even though the identical text also
    // arrived as a short cookie flag. Readability of the echoed date yields to credential safety.
    expect(logged).toContain('carried [redacted]')
    expect(logged).not.toContain('carried 1 ')
  } finally {
    fetcher.mockRestore()
    output.mockRestore()
  }
})

it('restricts only the short deployment cookie value, not the whole cookie pair', async () => {
  const output = vi.spyOn(console, 'info').mockImplementation(() => undefined)
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
    code: 0, data: { biz_code: 0, biz_data: { flag_echo: '1', granted_at: '2026-09-21T12:00:00Z' } },
  })))
  try {
    await requestPlatform('https://platform.deepseek.com', 'auth_init', {},
      new AbortController().signal, { cookie: '_ds_d28ddae08ee24f90c1b0cb9d912757e2=1' })
    const logged = diagnostics(output)
    expect(logged).toContain('"granted_at":"2026-09-21T12:00:00Z"')
    // The flag is not a credential, yet a field carrying exactly it is still replaced.
    expect(logged).toContain('"flag_echo":"[redacted]"')
  } finally {
    fetcher.mockRestore()
    output.mockRestore()
  }
})

it('redacts the whole deployment cookie pair as a substring', async () => {
  const output = vi.spyOn(console, 'info').mockImplementation(() => undefined)
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
    code: 0, data: { biz_code: 0, biz_data: { note: 'echo _ds_routing=1 back' } },
  })))
  try {
    await requestPlatform('https://platform.deepseek.com', 'auth_init', {},
      new AbortController().signal, { cookie: '_ds_routing=1' })
    const logged = diagnostics(output)
    expect(logged).toContain('echo [redacted] back')
    expect(logged).not.toContain('_ds_routing=1')
  } finally {
    fetcher.mockRestore()
    output.mockRestore()
  }
})

it('still redacts a real cookie secret echoed beside a short routing flag', async () => {
  const output = vi.spyOn(console, 'info').mockImplementation(() => undefined)
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
    code: 0, data: { biz_code: 0, biz_data: { note: 'echo abcdef123456 at 2026-10-21 for 1.50' } },
  })))
  try {
    await requestPlatform('https://platform.deepseek.com', 'auth_init', {},
      new AbortController().signal, {
        cookie: 'platform_target_env_port=20022; session_id=abcdef123456',
      })
    const logged = diagnostics(output)
    expect(logged).toContain('echo [redacted] at 2026-10-21 for 1.50')
    expect(logged).not.toContain('abcdef123456')
  } finally {
    fetcher.mockRestore()
    output.mockRestore()
  }
})

it('keeps a non-authorization URL in a non-JSON failure body readable', async () => {
  const output = vi.spyOn(console, 'info').mockImplementation(() => undefined)
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
    'see https://docs.example.com/errors for details', { status: 500 }))
  try {
    await expect(requestPlatform('https://platform.deepseek.com', 'auth_init', {},
      new AbortController().signal, {})).rejects.toThrow('account: network')
    const logged = diagnostics(output)
    expect(logged).toContain('see https://docs.example.com/errors for details')
  } finally {
    fetcher.mockRestore()
    output.mockRestore()
  }
})

it('redacts a credential nested in a request body array from an echoed failure body', async () => {
  const output = vi.spyOn(console, 'info').mockImplementation(() => undefined)
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response('echo nested-token-secret', { status: 500 }))
  try {
    await expect(requestPlatform('https://platform.deepseek.com', 'auth_init',
      { code_verifier: 'verifier-secret', entries: [{ token: 'nested-token-secret' }] },
      new AbortController().signal, {})).rejects.toThrow('account: network')
    const logged = diagnostics(output)
    expect(logged).toContain('echo [redacted]')
    expect(logged).not.toContain('nested-token-secret')
  } finally {
    fetcher.mockRestore()
    output.mockRestore()
  }
})

it('reports transport failure without exposing the thrown error', async () => {
  const output = vi.spyOn(console, 'info').mockImplementation(() => undefined)
  const fetcher = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('private-network-detail'))
  try {
    await expect(requestPlatform('https://platform.deepseek.com', 'auth_init', {},
      new AbortController().signal, {})).rejects.toThrow('account: network')
    const logged = JSON.stringify(output.mock.calls)
    expect(logged).toContain('network')
    expect(logged).not.toContain('private-network-detail')
  } finally {
    fetcher.mockRestore()
    output.mockRestore()
  }
})


it('identifies invalid envelope fields and redacts response credentials', async () => {
  const output = vi.spyOn(console, 'info').mockImplementation(() => undefined)
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
    code: 0, data: { biz_code: 'private-code', biz_data: { token: 'private-token' } },
  })))
  try {
    await expect(requestPlatform('https://platform.deepseek.com', 'auth_init', {},
      new AbortController().signal, {})).rejects.toThrow('account: protocol')
    const logged = JSON.stringify(output.mock.calls)
    expect(logged).toContain('envelope')
    expect(logged).toContain('biz_code')
    expect(logged).toContain('invalid_type')
    expect(logged).not.toContain('private-token')
    expect(logged).toContain('[redacted]')
  } finally {
    fetcher.mockRestore()
    output.mockRestore()
  }
})

it('keeps unrelated code fields readable while redacting numeric credentials', async () => {
  const output = vi.spyOn(console, 'info').mockImplementation(() => undefined)
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
    error_code: 'DECODER_INVALID', decoder: 'json', retry_code: 'RATE_LIMITED',
    access_token: 123456, code_verifier: 'verifier-secret',
  }), { status: 500 }))
  try {
    await expect(requestPlatform('https://platform.deepseek.com', 'auth_exchange',
      {}, new AbortController().signal, {})).rejects.toThrow('account: network')
    const logged = diagnostics(output)
    for (const readable of ['DECODER_INVALID', 'decoder', 'RATE_LIMITED']) expect(logged).toContain(readable)
    for (const secret of ['123456', 'verifier-secret']) expect(logged).not.toContain(secret)
  } finally {
    fetcher.mockRestore()
    output.mockRestore()
  }
})

it('reports browser URL rejection rules without exposing the destination', () => {
  const output = vi.spyOn(console, 'info').mockImplementation(() => undefined)
  try {
    expect(() => browserUrl('https://private.example/wrong?code=private-code',
      'https://platform.deepseek.com', '/dsh/authorize')).toThrow('account: protocol')
    const rejected = output.mock.calls.find(call => call[0] === '[deepseek-account] browser URL rejected')
    expect(rejected).toBeDefined()
    const fields = JSON.parse(JSON.stringify(rejected?.[1])) as Record<string, unknown>
    expect(fields).toMatchObject({
      path: '/dsh/authorize', originMismatch: true, pathMismatch: true,
      hasCredentials: false, hasFragment: false,
    })
    expect(Object.keys(fields).sort()).toEqual(['at', 'hasCredentials', 'hasFragment', 'originMismatch', 'path', 'pathMismatch'])
    expect(JSON.stringify(rejected?.[1])).toMatch(ISO_TIMESTAMP)
    expect(() => browserUrl('private-invalid-url', 'https://platform.deepseek.com',
      '/dsh/authorize')).toThrow('account: protocol')
    expect(JSON.stringify(output.mock.calls)).not.toContain('private-')
  } finally {
    output.mockRestore()
  }
})

it.each([
  { name: 'HTTP failure', response: () => new Response('private-error', { status: 503 }), code: 'network', logged: ['private-error', '503', 'network'] },
  { name: 'missing body', response: () => new Response(null), code: 'network', logged: ['empty'] },
  { name: 'oversized body', response: () => new Response('x'.repeat(65_537)), code: 'protocol', logged: ['body-limit', 'limit'] },
  { name: 'invalid JSON', response: () => new Response('{private-invalid'), code: 'protocol', logged: ['parse-json', 'private-invalid'] },
  { name: 'missing envelope data', response: () => new Response('{"code":0}'), code: 'protocol', logged: ['envelope', '{"code":0}'] },
  { name: 'broken response stream', response: () => new Response(new ReadableStream({
    start(controller) { controller.error(new Error('private-stream-error')) },
  })), code: 'protocol', logged: ['read-body', 'stream'] },
])('rejects $name with its existing classification and bounded diagnostics', async ({ response, code, logged }) => {
  const output = vi.spyOn(console, 'info').mockImplementation(() => undefined)
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response())
  try {
    await expect(requestPlatform('https://platform.deepseek.com', 'auth_init', {},
      new AbortController().signal, {})).rejects.toThrow(`account: ${code}`)
    const text = diagnostics(output)
    for (const expected of logged) expect(text).toContain(expected)
    expect(text).not.toContain('private-stream-error')
  } finally {
    fetcher.mockRestore()
    output.mockRestore()
  }
})
