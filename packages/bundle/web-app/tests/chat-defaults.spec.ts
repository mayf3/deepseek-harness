/** Profile work-details defaults and saved Chat overrides through the shipped Loader row. */
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { applyEntryPatches, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import * as Chat from '@deepseek-ai/dsh-client-ui-chat'
import { expect, it, onTestFinished } from 'vitest'
import { plainConfig } from '../../../settings/settings/src/schema.ts'

async function loadChat(profile: string | undefined, overrides: PatchOptions[] = []) {
  const rows = loadOverlayPatches('chat-defaults', fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)))
    .flatMap(patch => patch.insert ?? []).filter(row => row.id === 'ui-chat')
  expect(rows).toHaveLength(1)
  expect(rows[0]!.name).toBe('@deepseek-ai/dsh-client-ui-chat')
  const configured = applyEntryPatches(rows, overrides, (message) => { throw new Error(message) })
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  if (profile !== undefined) {
    ctx.provide('profileContext', {
      name: profile, dir: '/profile', patchPath: '/profile/cordis.patch.yml', installAnchor: '/profile/package.json',
      cwd: '/workspace', home: '/home', startedBundles: [], overlays: [], telemetryDisabledEnv: undefined,
    })
  }
  ctx.baseUrl = 'file:///'
  await ctx.plugin(Loader).await()
  ctx.loader.builtins.chat = Chat
  await ctx.loader.root.update([{ ...configured[0]!, name: 'cordis:chat' }])
  await ctx.loader.await()
  return plainConfig(ctx.loader.resolve('ui-chat').fiber!.config)
}

it.each([
  { profile: 'web', expected: 'detailed' },
  { profile: 'custom-web', expected: 'detailed' },
  { profile: undefined, expected: 'detailed' },
  { profile: 'desktop', expected: 'standard' },
])('starts fresh $profile Chat settings in $expected', async ({ profile, expected }) => {
  expect(await loadChat(profile)).toMatchObject({
    transcriptView: expected, performanceUsage: 'detailed', linkOpening: 'sidebar',
  })
})

it.each(['compact', 'standard', 'detailed', 'verbose', 'normal', 'expanded'])(
  'preserves the saved %s mode over Web and Desktop defaults', async (mode) => {
    for (const profile of ['web', 'desktop']) {
      expect(await loadChat(profile, [{ id: 'ui-chat', config: { transcriptView: mode } }]))
        .toMatchObject({ transcriptView: mode })
    }
  },
)
