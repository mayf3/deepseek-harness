/** Cordis registration and live settings for the DeepSeek Messages provider. */

import type { Context } from '@deepseek-ai/cordis'
import { assertUsableApiKey, LlmError, resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { getOrCreateAnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-fs'
import { Config, resolveOptions } from './config.ts'
import type { Connection } from './config.ts'
import { DeepSeekMessagesAdapter } from './adapter.ts'

export { Config, resolveOptions } from './config.ts'
export type { CatalogModel, Connection } from './config.ts'
export { DeepSeekMessagesAdapter } from './adapter.ts'
export type { AdapterDependencies } from './adapter.ts'

export const name = 'llm-deepseek-messages'
export const inject = ['llm']
const PROVIDER = 'deepseek-messages'

export function apply(ctx: Context, config: Config): void {
  let source = (): Config => config
  let previousRaw = config
  let current = resolveOptions(config, launchEnvironmentOf(ctx))
  const connection = (): Connection => {
    const raw = source()
    if (raw !== previousRaw) {
      previousRaw = raw
      try { current = resolveOptions(raw, launchEnvironmentOf(ctx)) } catch (error) {
        ctx.logger.error('llm-deepseek-messages: invalid settings; retaining the last good connection', error)
      }
    }
    return current
  }
  let userId: string | undefined
  const adapter = new DeepSeekMessagesAdapter({
    connection,
    onReplayDegrade: ({ provider, model, reason }) => {
      ctx.logger.warn(`llm-deepseek-messages: unusable replay state on assistant history for route "${provider}/${model}"; sending that message as provider-neutral content (${reason})`)
    },
    async apiKey(snapshot) {
      const credentials = ctx.get('credentials')
      const value = credentials === undefined
        ? launchEnvironmentOf(ctx).get(snapshot.apiKeyEnv)?.value
        : (await credentials.resolve(snapshot.apiKeyEnv))?.value
      if (value === undefined || value.length === 0) {
        throw new LlmError(`llm-deepseek-messages: configure credential ${snapshot.apiKeyEnv}`, 'MISSING_CREDENTIAL')
      }
      return assertUsableApiKey(value, name, snapshot.apiKeyEnv)
    },
    userId: () => userId ??= getOrCreateAnonymousUserId(),
    attachments: () => ctx.get('attachments'),
    imageAccess: (ref) => {
      const attachments = ctx.get('attachments')
      return attachments === undefined ? undefined : resolveImageAttachmentAccess(attachments, path => ctx.get('fs')?.processPathFromHostPath(path), ref)
    },
  })
  ctx.llm.registerConfigurableProviders([{ provider: PROVIDER, displayName: 'DeepSeek', settingsNs: name, settingsPath: [] }])
  const registration = ctx.llm.registerAdapter([PROVIDER], adapter)
  let retryPolicy = current.retryPolicy
  ctx.inject(['settings'], (child) => {
    child.settings.installSection(ctx, name, Config, config, {
      setSource: (next) => { source = next },
      onChange: () => {
        const nextPolicy = connection().retryPolicy
        if (!deepEqualJson(retryPolicy, nextPolicy)) {
          registration.replace([PROVIDER])
          retryPolicy = nextPolicy
        }
      },
    })
  })
}
