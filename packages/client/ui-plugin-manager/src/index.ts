/** Host network-country lookup for the plugin installation dialog. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { lookupIpCountry } from '@deepseek-ai/dsh-ip-geolocation'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

declare module '@deepseek-ai/cordis' {
  interface Context {
    pluginInstallLocation: PluginInstallLocation
  }
}

/** Country lookup endpoint, request bounds, and process-local cache policy. */
export interface Config {
  /** Whether the dialog can query the Host network country. */
  countryLookupEnabled: boolean
  /** HTTP(S) endpoint returning a two-letter `country` field. */
  countryEndpoint: string
  /** Deadline for one lookup, including its body. */
  countryTimeoutMs: number
  /** Maximum country lookup response-body bytes. */
  countryMaxResponseBytes: number
  /** Lifetime of a known or unavailable country reading. */
  countryCacheTtlMs: number
}

/** Shares a bounded Host lookup across installation dialogs; source-selection policy belongs to the Client. */
export default class PluginInstallLocation extends TypertRemoteService {
  static Config: z<Partial<Config>, Config> = z.object({
    countryLookupEnabled: z.boolean().default(true),
    countryEndpoint: z.string().default('https://get.geojs.io/v1/ip/country.json'),
    countryTimeoutMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(1500),
    countryMaxResponseBytes: z.natural().min(1).default(4096),
    countryCacheTtlMs: z.natural().default(300000),
  })

  private readonly lifetime = new AbortController()
  private pending: Promise<string | null> | undefined
  private cached: { country: string | null; expiresAt: number } | undefined

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'pluginInstallLocation')
    const url = new URL(config.countryEndpoint)
    if (!['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '') {
      throw new TypeError('countryEndpoint must be an HTTP(S) URL without credentials')
    }
    ctx.effect(() => async () => {
      this.lifetime.abort()
      await this.pending
    })
  }

  /**
   * Read the Host's exit country through its configured outbound fetch transport.
   * Concurrent callers share one lookup; caller disconnects do not cancel other readers.
   * @returns country code, or null when disabled, unavailable, or the lookup fails; both outcomes are cached.
   * @throws rejects when the service has been unloaded.
   */
  @Remote
  async country(): Promise<string | null> {
    this.lifetime.signal.throwIfAborted()
    if (!this.config.countryLookupEnabled) return null
    if (this.cached !== undefined && this.cached.expiresAt > Date.now()) return this.cached.country
    this.pending ??= this.lookup(this.config.countryEndpoint).finally(() => { this.pending = undefined })
    return this.pending
  }

  private async lookup(endpoint: string): Promise<string | null> {
    const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(this.config.countryTimeoutMs)])
    let country: string | null
    try {
      country = await lookupIpCountry({ endpoint, signal, maxResponseBytes: this.config.countryMaxResponseBytes })
    } catch (error) {
      if (!this.lifetime.signal.aborted) this.ctx.logger.debug('IP country lookup unavailable: %s', String(error))
      country = null
    }
    if (!this.lifetime.signal.aborted) this.cached = { country, expiresAt: Date.now() + this.config.countryCacheTtlMs }
    return country
  }
}
