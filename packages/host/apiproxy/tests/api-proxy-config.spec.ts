/**
 * Settings events consumed by Client model and permission surfaces.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { SettingsProvider, settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type {
  CredentialInfo,
  CredentialKey,
  CredentialRecord,
  CredentialRecordEntry,
  CredentialRecordInfo,
  CredentialRef,
  ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'
import { AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE } from '@deepseek-ai/dsh-agent-default-model'

/** In-memory settings provider: the Service Definition base class owns all tested behavior. */
class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown>

  constructor(ctx: ConstructorParameters<typeof SettingsProvider>[0], options?: {
    doc?: Record<string, unknown>
    readOnly?: boolean
    documentPath?: string
    preparedPath?: string
  }) {
    super(ctx)
    this.doc = structuredClone(options?.doc ?? {})
    this.readOnly = options?.readOnly ?? false
    this.path = options?.documentPath
    this.preparedPath = options?.preparedPath
  }

  private readonly readOnly: boolean
  private readonly path: string | undefined
  private readonly preparedPath: string | undefined

  get writable(): boolean {
    return !this.readOnly
  }

  override get documentPath(): string | undefined {
    return this.path
  }

  override prepareDocument(): Promise<string | undefined> {
    return Promise.resolve(this.preparedPath ?? this.documentPath)
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc[ns] = structuredClone(section)
    return Promise.resolve()
  }
}

/** In-memory credential provider with an env-shadow double for the rejection path. */
class MemoryCredentials extends CredentialProvider {
  private readonly values = new Map<string, string>()

  constructor(ctx: ConstructorParameters<typeof CredentialProvider>[0], options?: { shadowed?: string[] }) {
    super(ctx)
    this.shadowed = new Set(options?.shadowed ?? [])
  }

  private readonly shadowed: Set<string>

  resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    if (this.shadowed.has(ref)) return Promise.resolve({ value: 'from-env', source: 'env' })
    const value = this.values.get(ref)
    return Promise.resolve(value === undefined ? undefined : { value, source: 'file' })
  }

  describe(ref: CredentialRef): Promise<CredentialInfo> {
    if (this.shadowed.has(ref)) return Promise.resolve({ configured: true, source: 'env', writable: false })
    const configured = this.values.has(ref)
    return Promise.resolve({ configured, ...configured ? { source: 'file' } : {}, writable: true })
  }

  set(ref: CredentialRef, value: string): Promise<void> {
    if (this.shadowed.has(ref)) {
      return Promise.reject(new Error(`credentials: ${ref} is shadowed by the read-only environment`))
    }
    this.values.set(ref, value)
    this.ctx.emit('credentials/reference-updated', ref)
    return Promise.resolve()
  }

  unset(ref: CredentialRef): Promise<void> {
    if (this.shadowed.has(ref)) {
      return Promise.reject(new Error(`credentials: ${ref} is shadowed by the read-only environment`))
    }
    this.values.delete(ref)
    this.ctx.emit('credentials/reference-updated', ref)
    return Promise.resolve()
  }

  // The record half has no wire face on this proxy, so the double answers the
  // empty store rather than modelling storage the tests never exercise.
  readRecord(): Promise<CredentialRecord | undefined> {
    return Promise.resolve(undefined)
  }

  describeRecord(): Promise<CredentialRecordInfo> {
    return Promise.resolve({ configured: false, writable: true })
  }

  listRecords(): Promise<readonly CredentialRecordEntry[]> {
    return Promise.resolve([])
  }

  modifyRecord(
    _key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    return mutate(undefined)
  }

  deleteRecord(): Promise<void> {
    return Promise.resolve()
  }
}

const NS = settingsNamespace('llm-deepseek')

const AdapterConfig = z.object({
  apiKey: z.string().role('secret'),
  apiKeyEnv: z.string().default('DEEPSEEK_API_KEY'),
  baseURL: z.string(),
})

async function harness(options?: {
  settings?: false | {
    doc?: Record<string, unknown>
    readOnly?: boolean
    documentPath?: string
    preparedPath?: string
  }
  credentials?: false | { shadowed?: string[] }
}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  if (options?.settings !== false) await ctx.plugin(MemorySettings, options?.settings)
  if (options?.credentials !== false) await ctx.plugin(MemoryCredentials, options?.credentials)
  return ctx
}

/** Observe settings commits while one API operation runs. */
async function captureSettingsUpdates(
  ctx: Context,
  run: () => Promise<void>,
): Promise<Array<readonly [SettingsNamespace, number]>> {
  const updates: Array<readonly [SettingsNamespace, number]> = []
  const dispose = ctx.on('settings/document-updated', (namespace, revision) => {
    updates.push([namespace, revision])
  })
  try {
    await run()
    return updates
  } finally {
    dispose()
  }
}

/** Expected settings event tuple with its owner-assigned revision. */
function expectedSettingsUpdate(ns: string): readonly unknown[] {
  return [ns, expect.any(Number)]
}

describe('settings events', () => {
  it('forwards a provider settings change for model-catalog consumers', async () => {
    // Editing `models` changes no route, so llm/adapters-updated never fires
    // and an open model picker would keep serving the stale catalog. Storing
    // an override equal to the resolved value emits nothing on
    // settings/updated, so another tab would never learn the field became
    // overridden.
    const ctx = await harness()
    ctx.settings.register(NS, AdapterConfig, { base: { baseURL: 'https://base' } })
    const updates = await captureSettingsUpdates(ctx, async () => {
      await ctx.settings.update(settingsNamespace('llm-deepseek'), { baseURL: 'https://base' })
    })
    expect(updates).toEqual([expectedSettingsUpdate('llm-deepseek')])
    // The resolved value never moved: base already said https://base.
    expect(ctx.settings.describe().find(view => String(view.ns) === 'llm-deepseek')?.value)
      .toEqual({ apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://base' })
  })

  it('broadcasts a permission change without invalidating the model catalog', async () => {
    const ctx = await harness()
    const permission = ctx.settings.register(settingsNamespace('permission'), z.object({
      defaultPreset: z.union(['read-only', 'workspace-write']).required(),
    }), {
      base: { defaultPreset: 'read-only' },
    })
    const updates = await captureSettingsUpdates(ctx, async () => {
      await permission.update({ defaultPreset: 'workspace-write' })
    })
    expect(updates).toEqual([expectedSettingsUpdate('permission')])
  })

  it('forwards an Agent-default settings change for model-catalog consumers', async () => {
    const ctx = await harness()
    const defaultModel = ctx.settings.register(AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE, z.object({
      provider: z.string().required(),
      model: z.string().required(),
    }), { base: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } })
    // The shared section names the selection every blank session resolves to,
    // so an externally edited default — another tab, a
    // hand-edited settings.yaml — has to reach an open selector as well.
    const updates = await captureSettingsUpdates(ctx, async () => {
      await defaultModel.replace({ provider: 'deepseek-official', model: 'deepseek-reasoner' })
    })
    expect(updates).toEqual([expectedSettingsUpdate('agent-default-model')])
  })






})
