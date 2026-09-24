/** Desktop renderer analytics sender; browser applications have no collection capability. */
import { Service, type Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-client-product-analytics/remote'
import type { ProductEvent, ProductEventMap } from '../events.ts'
export type { ProductEvent, ProductEventMap, TrackProductEvent } from '../events.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    productAnalytics: DesktopAnalytics
  }
}

class DesktopAnalytics extends Service {
  constructor(ctx: Context) { super(ctx, 'productAnalytics') }

  /** Whether this renderer may collect events under the launch-time policy. */
  get enabled(): boolean {
    return 'dshDesktop' in globalThis && (globalThis as typeof globalThis & { __DSH_PRODUCT_ANALYTICS__?: boolean }).__DSH_PRODUCT_ANALYTICS__ === true
  }

  /**
   * Send an event without retaining it for reconnect or later enablement.
   * @param name - event name.
   * @param attributes - approved business fields.
   */
  track<K extends keyof ProductEventMap>(name: K, attributes: ProductEventMap[K]): void {
    if (!this.enabled) return
    const event = { eventName: name, attributes, timestamp: Date.now() } as ProductEvent
    void this.submit(event)
  }

  private async submit(event: ProductEvent): Promise<void> {
    try { await this.ctx.remote.productAnalytics.report(event) } catch (_error) {
      // Missing or disconnected Remote services must not interrupt the interaction.
    }
  }
}

/** Analytics requires only the authenticated remote namespace. */
export const inject = ['remote', 'remote.productAnalytics']

/** @param ctx - browser application context. */
export function apply(ctx: Context): void { ctx.plugin(DesktopAnalytics) }
