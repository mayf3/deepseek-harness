/** Desktop-only analytics RPC and live compaction collection. */
import { type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-host-product-telemetry-otel'
import type {} from '@deepseek-ai/dsh-deepseek-account'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-compaction/types'
import type { ProductEvent } from './events.ts'

/** Application-owned collection policy; no user settings surface. */
export interface Config {
  /** Desktop launcher opt-in; ordinary Web defaults to disabled. */
  enabled: boolean
  /** Running Desktop release, absent when unavailable. */
  appVersion?: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    productAnalytics: ProductAnalytics
  }
}

/** Authenticated event intake; disabled instances neither inspect identity nor construct an exporter. */
export default class ProductAnalytics extends TypertRemoteService {
  static inject = ['deepseekAccount', 'webServer']
  static Config = z.object({ enabled: z.boolean().default(false), appVersion: z.string() })
  private readonly collection: { active: boolean }

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'productAnalytics')
    this.collection = { active: config.enabled }
    ctx.effect(() => () => { this.collection.active = false })
    ctx.on('webserver/index-inject', (table) => {
      table.push({ kind: 'global', name: '__DSH_PRODUCT_ANALYTICS__', value: this.collection.active })
    })
    if (!this.collection.active) return
    if (ctx.get('productTelemetry') === undefined) ctx.logger.warn('Product analytics is enabled without productTelemetry; configure the exporter')
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'compaction/start') return
      void this.report({ eventName: 'context_compression', timestamp: Date.now(),
        attributes: { session_id: session.id, trigger_type: event.data.turn === null ? 'manual' : 'auto' } })
    })
  }

  /**
   * Read the collection policy.
   * @returns whether this Host currently accepts Desktop analytics.
   */
  @Remote
  enabled(): boolean { return this.collection.active }

  /**
   * Submit selected Desktop fields; missing identity is omitted and never generated.
   * @param event - typed product event without message contents or credentials.
   * @returns after local submission; no delivery or warehouse acknowledgement.
   */
  @Remote
  async report(event: ProductEvent): Promise<void> {
    if (!this.collection.active) return
    try {
      const identity = await this.ctx.deepseekAccount.getDeviceIdentity().catch(() => undefined)
      if (!this.enabled()) return
      this.ctx.get('productTelemetry')?.emit({
        ...event, body: event.eventName,
        attributes: {
          ...event.attributes,
          ...identity?.deviceId === undefined ? {} : { device_id: identity.deviceId },
          ...identity?.userId === undefined ? {} : { user_id: identity.userId },
          ...this.config.appVersion === undefined ? {} : { app_version: this.config.appVersion },
          ...identity === undefined ? {} : { os_version: identity.osVersion },
        },
      })
    } catch (error) {
      this.ctx.logger.warn('Product analytics submission failed', error)
    }
  }
}
