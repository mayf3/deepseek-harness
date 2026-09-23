/** Desktop account settings registration and reconnecting Remote subscription. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { AccountView, AccountDetails } from '@deepseek-ai/dsh-deepseek-account/types'
import type { PlatformBridge } from './PlatformOverlay.tsx'
import { Config, CONTACT_CONFIG_GLOBAL } from '../contact-config.ts'
import { contactUrl } from './contact-url.ts'
import { AccountOnboarding } from './AccountOnboarding.tsx'
import { AccountMenu } from './AccountMenu.tsx'
import { AccountSection, type AccountSnapshot, type AccountSectionInjected } from './AccountSection.tsx'
import { createBonusNoticeController } from './bonus-notices.ts'
import { accountClientMetadata } from './client-metadata.ts'
import { en, zh, type AccountKey } from './locales.ts'
export type { AccountSectionInjected, AccountSectionProps } from './AccountSection.tsx'
export type { AccountMenuProps } from './AccountMenu.tsx'
export type { AccountSnapshot } from './AccountSection.tsx'
export type { AccountKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'settings.account': AccountKey }
}

/** @param error - caught failure. @returns its stable string code when one is present, otherwise undefined. */
function errorCodeOf(error: unknown): string | undefined {
  if (!(error instanceof Error) || !('code' in error)) return undefined
  const code: unknown = error.code
  return typeof code === 'string' ? code : undefined
}

/**
 * Classify one sign-out failure for the log. Thrown messages are omitted: a Remote
 * message or a native error may quote the values it failed on.
 * @param phase - sign-out step that refused the call.
 * @param error - caught failure; its own code and name replace the fallback classification.
 * @returns log fields carrying no message and no credential.
 */
function signOutFailure(phase: string, error: unknown): Record<string, string> {
  return { phase, errorCode: errorCodeOf(error) ?? 'unknown', errorName: error instanceof Error ? error.name : typeof error }
}

/**
 * Run one sign-out step and report the failing phase before rethrowing, so a throw
 * before or around the Remote call is distinguishable from a refused Remote result.
 * @param phase - sign-out step that ran.
 * @param step - the step to run.
 * @returns the step's value.
 */
async function signOutStep<Value>(phase: 'prepare-client' | 'invoke-remote', step: () => Value | Promise<Value>): Promise<Value> {
  try { return await step() }
  catch (error) {
    console.error('[ui-settings-account] sign-out failed', JSON.stringify(signOutFailure(phase, error)))
    throw error
  }
}

/** Services required by account settings. */
export const inject = ['slots', 'locale', 'remote', 'remote.account', 'theme']
/** Register account UI only in the Desktop renderer. @param ctx - client plugin context. */
export function apply(ctx: Context): void {
  if (!('dshDesktop' in globalThis)) return
  ctx.effect(() => ctx.locale.register('settings.account', { en, zh }), 'account: dictionaries')
  const t = ctx.locale.bind('settings.account')
  const page = globalThis as Partial<Record<typeof CONTACT_CONFIG_GLOBAL, unknown>>
  const config = Config(page[CONTACT_CONFIG_GLOBAL] ?? {})
  let snapshot: AccountSnapshot = { view: undefined, details: undefined, failed: false, loginVisible: false }
  const listeners = new Set<() => void>()
  const publish = (value: AccountSnapshot) => { snapshot = value; for (const listener of listeners) listener() }
  /** @returns the client identity for one account call, read at call time so it carries the language and zone in effect then. */
  const client = () => accountClientMetadata(ctx.locale.getSnapshot().active, process.env.DSH_CLIENT_VERSION)
  // The browser half of the notice lifecycle: reads when the account becomes
  // active and on an explicit refresh, and acknowledges an order only after its
  // card reports a presented frame. The Host owns which bonus is unnotified and
  // the server owns the copy.
  const notices = createBonusNoticeController({
    ackRetryDelayMs: config.bonusAckRetryDelayMs,
    ackRetryMaxDelayMs: config.bonusAckRetryMaxDelayMs,
    read: async () => {
      const result = await ctx.remote.account.getUnnotifiedBonuses(client())
      if (!result.ok) throw new Error('account bonus read failed')
      return result.value
    },
    acknowledge: async (accountId, orderId) => {
      const result = await ctx.remote.account.ackBonusNotified(accountId, orderId, client())
      if (!result.ok) throw new Error('account bonus acknowledgement failed')
      return result.value
    },
    publish: (notice) => {
      const { notice: _replaced, ...withoutNotice } = snapshot
      // exactOptionalPropertyTypes distinguishes an absent notice from an undefined one.
      publish(notice === null ? withoutNotice : { ...withoutNotice, notice })
    },
  })
  ctx.effect(() => () => { notices.end() }, 'account: bonus notice lifetime')
  let revision = 0
  let refreshing: Promise<void> | undefined
  const refresh = (): Promise<void> => {
    if (snapshot.view?.status !== 'credential-stored') return Promise.resolve()
    if (refreshing !== undefined) return refreshing
    const generation = revision
    const read = async <K extends keyof AccountDetails>(field: K,
      query: () => Promise<AccountDetails[K] | null>) => {
      let value: AccountDetails[K] | null
      try { value = await query() }
      catch { value = { status: 'failed' } }
      if (generation === revision && value !== null) publish({ ...snapshot, details: { ...snapshot.details, [field]: value } })
    }
    const request = Promise.all([
      read('profile', async () => {
        const result = await ctx.remote.account.getProfile(client())
        if (!result.ok) throw new Error('account profile failed')
        return result.value
      }),
      read('balance', async () => {
        const result = await ctx.remote.account.getBalance(client())
        if (!result.ok) throw new Error('account balance failed')
        return result.value
      }),
    ]).then(() => undefined)
    refreshing = request
    void request.finally(() => { if (refreshing === request) refreshing = undefined })
    return request
  }
  ctx.effect(() => () => { revision++ }, 'account: details request lifetime')
  const stream = ctx.remote.$stream<AccountView>({
    name: 'account', open: signal => ctx.remote.account.watch(signal), ended: () => new Error('account stream ended'),
  })
  let disposed = false
  ctx.effect(() => () => { disposed = true; return stream.dispose() }, 'account: state stream')
  void (async () => {
    for await (const frame of stream) {
      revision++
      refreshing = undefined
      const { notice, ...previous } = snapshot
      publish({ ...previous, view: frame.value, details: undefined, failed: false,
        ...(frame.value.status === 'credential-stored' && notice ? { notice } : {}) })
      frame.accept()
      if (frame.value.status === 'credential-stored') notices.begin()
      else notices.end()
      void refresh()
    }
  })().catch(() => { if (!disposed) publish({ ...snapshot, failed: true }) })
  const nativePlatform = (globalThis as typeof globalThis & { dshPlatform?: PlatformBridge }).dshPlatform
  const operations: AccountSectionInjected = {
    ...nativePlatform === undefined ? {} : { platform: nativePlatform },
    refresh,
    // One Settings entry: the recharge/bonus wallet and the unnotified-bonus read,
    // whichever section the panel opens on. Both reads are independent.
    async refreshOnSettingsOpen() { await Promise.all([refresh(), notices.refresh()]) },
    contactUs() {
      const url = contactUrl(config, {
        version: process.env.DSH_CLIENT_VERSION,
        locale: ctx.locale.getSnapshot().active === 'zh' ? 'zh-CN' : 'en',
        width: window.screen.width, height: window.screen.height, pixelRatio: window.devicePixelRatio,
      })
      window.open(url, '_blank', 'noopener,noreferrer')
    },
    showLogin(visible) { publish({ ...snapshot, loginVisible: visible }) },
    setOnboarding(active) { publish({ ...snapshot, onboarding: active }) },
    bonusNoticeShown(orderId) { notices.shown(orderId) },
    bonusNoticeDismissed(orderId) { notices.dismiss(orderId) },
    hooks: {
      account: {
        getSnapshot: () => snapshot,
        subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
      },
      theme: {
        getSnapshot: () => ctx.theme.getTheme(),
        subscribe: listener => ctx.on('theme/change', listener),
      },
    },
    async start() {
      publish({ ...snapshot, loginVisible: true, loginFailed: false })
      const transport = (globalThis as typeof globalThis & {
        __DSH_TRANSPORT__?: { streamBaseUrl?: string }
      }).__DSH_TRANSPORT__
      try {
        const result = await ctx.remote.account.startSignIn(client(),
          transport?.streamBaseUrl !== undefined ? new URL(transport.streamBaseUrl).origin : window.location.origin,
          'desktop')
        if (!result.ok) throw new Error('account start failed')
      } catch (error) {
        publish({ ...snapshot, loginFailed: true })
        throw error
      }
    },
    async cancel(id) { const result = await ctx.remote.account.cancelSignIn(id); if (!result.ok) throw new Error('account cancel failed') },
    async signOut() {
      const metadata = await signOutStep('prepare-client', client)
      const result = await signOutStep('invoke-remote', () => ctx.remote.account.signOut(metadata))
      if (result.ok) return
      console.error('[ui-settings-account] sign-out failed', JSON.stringify(signOutFailure('result', result.error)))
      throw result.error
    },
  }
  ctx.slots.inject('settings.models.sign-in', () => ctx.slots.register({
    name: 'settings.models.sign-in', locale: 'settings.account', inject: () => operations,
  }, AccountOnboarding))
  ctx.slots.inject('settings.launcher', () => ctx.slots.register({
    name: 'settings.launcher', locale: 'settings.account', inject: () => operations,
  }, AccountMenu))
  ctx.slots.inject('settings.section', () => {
    let unregister: (() => void) | undefined
    const update = () => {
      if (snapshot.view?.status === 'credential-stored') {
        unregister ??= ctx.slots.register({
          name: 'settings.section', id: 'account', order: -10, label: () => t('nav'),
          locale: 'settings.account', inject: () => operations,
        }, AccountSection)
      } else {
        unregister?.()
        unregister = undefined
      }
    }
    listeners.add(update)
    update()
    return () => { listeners.delete(update); unregister?.() }
  })
}
