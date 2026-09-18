// @vitest-environment jsdom
/** Account state updates continue after default-model initialization refuses. */
import { expect, it, vi } from 'vitest'
import type { AccountView, SignInAttemptId } from '@deepseek-ai/dsh-deepseek-account/types'
import { apply, type AccountSectionInjected } from '../src/client/index.ts'

it.each(['accepted', 'refused', 'disconnected'] as const)('initializes account models and keeps reading account state: %s', async (outcome) => {
  const abort = new AbortController()
  const done = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const initializeDefaultModel = vi.fn(async () => {
    if (outcome === 'disconnected') throw new Error('connection lost')
    return { ok: outcome === 'accepted', value: undefined }
  })
  const links = { usageUrl: 'https://example.test/usage', topUpUrl: 'https://example.test/top_up' }
  const signedIn: AccountView = {
    status: 'credential-stored', links, attempt: { id: 'login' as SignInAttemptId, phase: 'succeeded' },
  }
  const frames: AccountView[] = [signedIn, signedIn, { status: 'signed-out', links, attempt: null }]
  const disposers: (() => void)[] = []
  let operations: AccountSectionInjected | undefined
  const ctx = {
    effect: (install: () => (() => void) | undefined) => { const dispose = install(); if (dispose) disposers.push(dispose) },
    locale: { register: () => () => {}, bind: () => (key: string) => key },
    slots: {
      inject: (_name: string, install: () => (() => void) | undefined) => {
        const dispose = install()
        if (dispose) disposers.push(dispose)
      },
      register: (entry: { inject?: () => AccountSectionInjected }) => {
        if (entry.inject) operations = entry.inject()
        return () => {}
      },
    },
    remote: {
      session: { initializeDefaultModel },
      account: { getProfile: async () => ({ ok: true, value: null }), getBalance: async () => ({ ok: true, value: null }) },
      $stream: () => ({
        signal: abort.signal, dispose: () => { abort.abort(); release.resolve(undefined) },
        async *[Symbol.asyncIterator]() {
          for (const value of frames) yield { value, accept: () => { if (value.status === 'signed-out') done.resolve(undefined) } }
          await release.promise
        },
      }),
    },
  }
  try {
    apply(ctx as never)
    await done.promise
    expect(initializeDefaultModel).toHaveBeenCalledExactlyOnceWith('deepseek-account')
    expect(operations?.hooks.account.getSnapshot()).toMatchObject({ view: { status: 'signed-out' }, failed: false })
  } finally {
    for (const dispose of disposers.reverse()) dispose()
  }
})
