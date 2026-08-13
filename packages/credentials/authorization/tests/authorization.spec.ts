import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import AuthorizationService, {
  type AuthorizationFlow,
  type AuthorizationInteraction,
  type AuthorizationSession,
} from '@deepseek-ai/dsh-authorization'
import { MemoryCredentials } from './memory.ts'

const KEY = credentialKey('llm-pi-ai', 'openai-codex')
const OTHER = credentialKey('llm-pi-ai', 'anthropic')

/** A context with the record store the seam confirms commits against. */
async function harness(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(MemoryCredentials)
  await ctx.plugin(AuthorizationService)
  return ctx
}

/** An interaction that answers every prompt with the same string. */
function surface(answer = 'typed'): AuthorizationInteraction & {
  notices: unknown[]
  prompts: unknown[]
} {
  const notices: unknown[] = []
  const prompts: unknown[] = []
  return {
    notices,
    prompts,
    notify: (notice) => { notices.push(notice) },
    prompt: (prompt) => {
      prompts.push(prompt)
      return Promise.resolve(answer)
    },
  }
}

/** A flow that commits `key` through the record store and then resolves. */
function committingFlow(
  ctx: Context,
  key = KEY,
  run?: (session: AuthorizationSession) => Promise<void>,
): AuthorizationFlow {
  return {
    key,
    label: 'ChatGPT (Codex)',
    methods: [{ id: 'oauth', label: 'Sign in with ChatGPT' }, { id: 'api-key', label: 'Paste a key' }],
    async run(session) {
      await run?.(session)
      await ctx.credentials.modifyRecord(key, () =>
        Promise.resolve({ kind: 'grant', payload: { token: 'granted' } }))
    },
  }
}

describe('AuthorizationService registry', () => {
  it('lists a registered flow and drops it when the registration is disposed', async () => {
    const ctx = await harness()

    const dispose = ctx.authorization.registerFlow(committingFlow(ctx))

    expect(ctx.authorization.list()).toEqual([{
      key: KEY,
      label: 'ChatGPT (Codex)',
      methods: [{ id: 'oauth', label: 'Sign in with ChatGPT' }, { id: 'api-key', label: 'Paste a key' }],
      inFlight: false,
    }])
    expect(ctx.authorization.describe(KEY)?.label).toBe('ChatGPT (Codex)')
    expect(ctx.authorization.describe(OTHER)).toBeUndefined()

    dispose()

    expect(ctx.authorization.list()).toEqual([])
    expect(ctx.authorization.describe(KEY)).toBeUndefined()
  })

  it('refuses a second flow for the same key', async () => {
    const ctx = await harness()
    ctx.authorization.registerFlow(committingFlow(ctx))

    expect(() => ctx.authorization.registerFlow(committingFlow(ctx)))
      .toThrow(/already registered/)
  })

  it('withdraws an attempt still running when its flow leaves', async () => {
    const ctx = await harness()
    let started: (() => void) | undefined
    const running = new Promise<void>((resolve) => {
      started = resolve
    })
    const dispose = ctx.authorization.registerFlow(committingFlow(ctx, KEY, session =>
      new Promise((_resolve, reject) => {
        started?.()
        session.signal.addEventListener('abort', () => { reject(new Error('withdrawn')) }, { once: true })
      })))

    const attempt = ctx.authorization.begin({ key: KEY, interaction: surface() })
    await running
    dispose()

    await expect(attempt).resolves.toEqual({ status: 'cancelled' })
  })
})

describe('AuthorizationService.begin', () => {
  it('runs the flow, confirms the committed record, and reports the settlement', async () => {
    const ctx = await harness()
    ctx.authorization.registerFlow(committingFlow(ctx))
    const settled = vi.fn()
    ctx.on('authorization/settled', settled)

    await expect(ctx.authorization.begin({ key: KEY, interaction: surface() }))
      .resolves.toEqual({ status: 'authorized' })

    expect(await ctx.credentials.readRecord(KEY)).toEqual({ kind: 'grant', payload: { token: 'granted' } })
    expect(settled).toHaveBeenCalledWith(KEY, 'authorized')
  })

  it('runs the flow first method when the caller names none, and the named one when it does', async () => {
    const ctx = await harness()
    const seen: string[] = []
    ctx.authorization.registerFlow(committingFlow(ctx, KEY, (session) => {
      seen.push(session.method)
      return Promise.resolve()
    }))

    await ctx.authorization.begin({ key: KEY, interaction: surface() })
    await ctx.authorization.begin({ key: KEY, method: 'api-key', interaction: surface() })

    expect(seen).toEqual(['oauth', 'api-key'])
  })

  it('carries notices and prompts between the flow and the calling surface', async () => {
    const ctx = await harness()
    const answers: string[] = []
    ctx.authorization.registerFlow(committingFlow(ctx, KEY, async (session) => {
      session.notify({ message: 'Continue in your browser', url: 'https://auth.example/start' })
      answers.push(await session.prompt({ kind: 'text', message: 'Paste the code' }))
    }))
    const ui = surface('code-123')

    await ctx.authorization.begin({ key: KEY, interaction: ui })

    expect(ui.notices).toEqual([{ message: 'Continue in your browser', url: 'https://auth.example/start' }])
    expect(ui.prompts).toEqual([{ kind: 'text', message: 'Paste the code' }])
    expect(answers).toEqual(['code-123'])
  })

  it('refuses a key no flow claims', async () => {
    const ctx = await harness()

    await expect(ctx.authorization.begin({ key: KEY, interaction: surface() }))
      .rejects.toThrow(/no authorization flow is registered/)
  })

  it('refuses a method the flow does not offer', async () => {
    const ctx = await harness()
    ctx.authorization.registerFlow(committingFlow(ctx))

    await expect(ctx.authorization.begin({ key: KEY, method: 'device', interaction: surface() }))
      .rejects.toThrow(/offers no method "device"/)
  })

  it('refuses a second attempt while one is running, and admits one after it settles', async () => {
    const ctx = await harness()
    // Only the first attempt blocks; the later ones must be free to complete,
    // which is what shows the key was released rather than merely idle-looking.
    const held = Promise.withResolvers<undefined>()
    const started = Promise.withResolvers<undefined>()
    let first = true
    ctx.authorization.registerFlow(committingFlow(ctx, KEY, () => {
      if (!first) return Promise.resolve()
      first = false
      started.resolve(undefined)
      return held.promise
    }))

    const attempt = ctx.authorization.begin({ key: KEY, interaction: surface() })
    await started.promise
    expect(ctx.authorization.describe(KEY)?.inFlight).toBe(true)
    await expect(ctx.authorization.begin({ key: KEY, interaction: surface() }))
      .rejects.toThrow(/already running/)

    held.resolve(undefined)
    await expect(attempt).resolves.toEqual({ status: 'authorized' })
    expect(ctx.authorization.describe(KEY)?.inFlight).toBe(false)
    await expect(ctx.authorization.begin({ key: KEY, interaction: surface() }))
      .resolves.toEqual({ status: 'authorized' })
  })

  it('never starts a flow whose caller withdrew before begin', async () => {
    const ctx = await harness()
    const ran = vi.fn()
    const settled = vi.fn()
    ctx.on('authorization/settled', settled)
    ctx.authorization.registerFlow(committingFlow(ctx, KEY, () => {
      ran()
      return new Promise(() => {})
    }))

    await expect(ctx.authorization.begin({
      key: KEY,
      interaction: surface(),
      signal: AbortSignal.abort(),
    })).resolves.toEqual({ status: 'cancelled' })

    expect(ran).not.toHaveBeenCalled()
    // Nothing occupied the key, so nothing settled on it either.
    expect(settled).not.toHaveBeenCalled()
    expect(ctx.authorization.describe(KEY)?.inFlight).toBe(false)
  })

  it('still reports an unknown method to a caller that already withdrew', async () => {
    const ctx = await harness()
    ctx.authorization.registerFlow(committingFlow(ctx))

    await expect(ctx.authorization.begin({
      key: KEY,
      method: 'device',
      interaction: surface(),
      signal: AbortSignal.abort(),
    })).rejects.toThrow(/offers no method "device"/)
  })

  it('reports a caller that withdraws mid-flight as cancelled', async () => {
    const ctx = await harness()
    const controller = new AbortController()
    ctx.authorization.registerFlow(committingFlow(ctx, KEY, session =>
      new Promise((_resolve, reject) => {
        session.signal.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
        controller.abort()
      })))

    await expect(ctx.authorization.begin({ key: KEY, interaction: surface(), signal: controller.signal }))
      .resolves.toEqual({ status: 'cancelled' })
  })

  it('withdraws a running attempt through cancel(), and ignores cancel() for an idle key', async () => {
    const ctx = await harness()
    const started = Promise.withResolvers<undefined>()
    ctx.authorization.registerFlow(committingFlow(ctx, KEY, session =>
      new Promise((_resolve, reject) => {
        session.signal.addEventListener('abort', () => { reject(new Error('cancelled')) }, { once: true })
        started.resolve(undefined)
      })))
    ctx.authorization.cancel(OTHER)

    const attempt = ctx.authorization.begin({ key: KEY, interaction: surface() })
    await started.promise
    ctx.authorization.cancel(KEY)

    await expect(attempt).resolves.toEqual({ status: 'cancelled' })
  })

  it('propagates a flow failure to its caller and settles the key as failed', async () => {
    const ctx = await harness()
    ctx.authorization.registerFlow(committingFlow(ctx, KEY, () =>
      Promise.reject(new Error('the token endpoint said no'))))
    const settled = vi.fn()
    ctx.on('authorization/settled', settled)

    await expect(ctx.authorization.begin({ key: KEY, interaction: surface() }))
      .rejects.toThrow('the token endpoint said no')

    expect(settled).toHaveBeenCalledWith(KEY, 'failed')
    expect(ctx.authorization.describe(KEY)?.inFlight).toBe(false)
  })

  it('refuses a flow that resolves without committing its record', async () => {
    const ctx = await harness()
    ctx.authorization.registerFlow({
      key: KEY,
      label: 'Forgetful',
      methods: [{ id: 'oauth', label: 'Sign in' }],
      run: () => Promise.resolve(),
    })

    await expect(ctx.authorization.begin({ key: KEY, interaction: surface() }))
      .rejects.toThrow(/resolved without committing a credential record/)
  })
})
