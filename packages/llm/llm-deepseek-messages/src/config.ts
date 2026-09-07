/** Validated connection snapshots for the DeepSeek Messages adapter. */

import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { ReasoningEffortId, resolveRetryPolicy, RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import type { LlmResolvedModelInfo, RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import type { LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'

/** One advisory model entry; unlisted models remain callable as text-only models. */
export interface CatalogModel {
  /** Model id sent unchanged to the provider. */
  id: string
  /** Display label; omission uses the model id. */
  name?: string
  /** Exact-model context capacity in tokens. */
  contextWindow?: number
  /** Exact-model default output cap. */
  maxTokens?: number
  /** Accepted input modalities; omission advertises text only. */
  inputModalities?: ('text' | 'image')[]
  /** Total-pixel target used to normalize request images. */
  imagePixelBudget?: number
  /** Encoded-byte target used to normalize each request image. */
  imageMaxBytes?: number
}

/** Composition configuration and the `llm-deepseek-messages` settings section. */
export interface Config {
  /** Credential reference resolved per request; defaults to DEEPSEEK_API_KEY. */
  apiKeyEnv?: string
  /** Messages protocol root, without /v1/messages; defaults to DEEPSEEK_MESSAGES_BASE_URL, then https://api.deepseek.com/anthropic. */
  baseURL?: string
  /** Deployment policy; disabled permits only off. */
  thinking?: 'enabled' | 'disabled'
  /** Default effort; high unless thinking is disabled. */
  reasoningEffort?: 'off' | 'low' | 'high' | 'max'
  /** Default output cap, including thinking tokens; defaults to 256000. */
  maxTokens?: number
  /** Context capacity for models without an explicit entry; defaults to 1000000. */
  defaultContextWindow?: number
  /** Advisory catalog; omission advertises V4 Flash, Pro, and Flash Vision Exp. */
  models?: CatalogModel[]
  /** Maximum idle time while waiting on the provider; defaults to 300000 ms. */
  streamIdleTimeoutMs?: number
  /** Maximum aggregate base64 image bytes; defaults to 20 MiB. */
  maxInlineRequestImageBytes?: number
  /** Maximum retained image occurrences; defaults to 600. */
  maxImagesPerRequest?: number
  /** Oldest-image byte removal quantum; defaults to 10 MiB. */
  inlineImageOffloadByteQuantum?: number
  /** Oldest-image count removal quantum; defaults to 20. */
  imageOffloadCountQuantum?: number
  /** Provider retry policy executed by llm-retry. */
  retryPolicy?: RetryPolicyConfig
}

const positive = () => z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER)
const modelSchema: z<CatalogModel> = z.object({
  id: z.string().required(),
  name: z.string(),
  contextWindow: positive(),
  maxTokens: positive(),
  inputModalities: z.array(z.union(['text', 'image'])).min(1).default(['text']),
  imagePixelBudget: positive(),
  imageMaxBytes: positive(),
})

const catalog: CatalogModel[] = [
  { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' },
  { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
  { id: 'deepseek-v4-flash-vision-exp', name: 'DeepSeek-V4-Flash-Vision-Exp', inputModalities: ['text', 'image'] },
]

/** Runtime schema shared by Loader and dynamic settings. */
export const Config: z<Config> = z.object({
  apiKeyEnv: z.string().role('credential-ref').default('DEEPSEEK_API_KEY'),
  baseURL: z.string(),
  thinking: z.union(['enabled', 'disabled']),
  reasoningEffort: z.union(['off', 'low', 'high', 'max']),
  maxTokens: positive().default(256_000),
  defaultContextWindow: positive().default(1_000_000),
  models: z.array(modelSchema).default(catalog),
  streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(300_000),
  maxInlineRequestImageBytes: positive().default(20 * 1024 * 1024),
  maxImagesPerRequest: positive().default(600),
  inlineImageOffloadByteQuantum: positive().default(10 * 1024 * 1024),
  imageOffloadCountQuantum: positive().default(20),
  retryPolicy: RetryPolicySchema,
})

/** Resolve configuration before registration or publication of a settings generation.
 * @param raw - composition or settings values.
 * @param environment - launch-owned environment used for the endpoint fallback.
 * @returns a detached, validated connection snapshot.
 */
export function resolveOptions(raw: Config, environment?: LaunchEnvironmentSnapshot): Connection {
  // The schema materializes each required connection field before this assertion.
  const config = Config(raw) as Config & Required<Pick<Config,
    'apiKeyEnv' | 'models' | 'maxTokens' | 'defaultContextWindow' | 'streamIdleTimeoutMs'
    | 'maxInlineRequestImageBytes' | 'maxImagesPerRequest' | 'inlineImageOffloadByteQuantum' | 'imageOffloadCountQuantum'
  >>
  const baseURL = new URL(config.baseURL ?? environment?.get('DEEPSEEK_MESSAGES_BASE_URL')?.value
    ?? 'https://api.deepseek.com/anthropic')
  if (!['http:', 'https:'].includes(baseURL.protocol) || baseURL.username || baseURL.password || baseURL.search || baseURL.hash) {
    throw new Error('llm-deepseek-messages: baseURL must be an HTTP(S) protocol root without credentials, query, or fragment')
  }
  if (config.thinking === 'disabled' && config.reasoningEffort !== undefined && config.reasoningEffort !== 'off') {
    throw new Error('llm-deepseek-messages: disabled thinking requires reasoningEffort off')
  }
  if (config.inlineImageOffloadByteQuantum > config.maxInlineRequestImageBytes
    || config.imageOffloadCountQuantum > config.maxImagesPerRequest) {
    throw new Error('llm-deepseek-messages: image removal quanta must not exceed their request budgets')
  }
  const models = structuredClone(config.models)
  const ids = new Set<string>()
  for (const model of models) {
    if (!model.id || ids.has(model.id) || model.name === '') {
      throw new Error('llm-deepseek-messages: model ids must be nonempty and unique; names must not be empty')
    }
    ids.add(model.id)
  }
  return {
    thinking: config.thinking,
    baseURL: baseURL.href.replace(/\/+$/u, ''),
    apiKeyEnv: credentialRef(config.apiKeyEnv),
    maxTokens: config.maxTokens,
    defaultContextWindow: config.defaultContextWindow,
    streamIdleTimeoutMs: config.streamIdleTimeoutMs,
    maxInlineRequestImageBytes: config.maxInlineRequestImageBytes,
    maxImagesPerRequest: config.maxImagesPerRequest,
    inlineImageOffloadByteQuantum: config.inlineImageOffloadByteQuantum,
    imageOffloadCountQuantum: config.imageOffloadCountQuantum,
    reasoningEffort: config.reasoningEffort ?? (config.thinking === 'disabled' ? 'off' : 'high'),
    models,
    retryPolicy: resolveRetryPolicy(config.retryPolicy, 'llm-deepseek-messages: retryPolicy'),
  }
}

/** Complete operation-local connection facts. */
export type Connection = Required<Omit<Config, 'thinking' | 'apiKeyEnv' | 'retryPolicy'>> & {
  thinking: Config['thinking']
  apiKeyEnv: ReturnType<typeof credentialRef>
  retryPolicy: ReturnType<typeof resolveRetryPolicy>
}

/** Resolve exact-route model defaults without restricting the advisory catalog.
 * @param connection - validated configuration snapshot.
 * @param provider - registered route.
 * @param model - requested model id.
 * @returns metadata materialized by LlmRuntime into the logged request.
 */
export function modelInfo(connection: Connection, provider: string, model: string): LlmResolvedModelInfo {
  const entry = connection.models.find(candidate => candidate.id === model)
  const efforts = connection.thinking === 'disabled' ? ['off'] : ['off', 'low', 'high', 'max']
  return {
    provider, id: model, name: entry?.name ?? model,
    inputModalities: entry?.inputModalities ?? ['text'],
    context: { contextWindow: entry?.contextWindow ?? connection.defaultContextWindow },
    defaultMaxTokens: entry?.maxTokens ?? connection.maxTokens,
    reasoning: {
      defaultEffort: ReasoningEffortId(connection.reasoningEffort),
      efforts: efforts.map(id => ({ id: ReasoningEffortId(id), name: id })),
    },
  }
}
