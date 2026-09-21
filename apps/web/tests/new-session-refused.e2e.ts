/** An explicit New Session the Host refuses reports through the Workspace notice in the shipped Web composition. */
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { describe, expect, it, onTestFinished } from 'vitest'
import { compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode } from './scaffold.ts'
import { saveFailureShot } from './support.ts'

const NOTICE_EXPECTED = fileURLToPath(new URL('./expected/new-session-refused/notice.expected.md', import.meta.url))
const MODE = webSnapshotMode()
/** The default preset of this lane: its one row names a package the Host cannot resolve, as a preset copied before a plugin rename does. */
const PRESET_ID = 'renamed-plugin'

/**
 * Seed a user preset root holding one preset the roster reads as broken.
 *
 * Discovery reports the unresolvable row before any mount, so the refusal
 * carries no temp path and the notice text is stable across runs.
 * @param root - the lane-owned preset root.
 */
async function seedBrokenPreset(root: string): Promise<void> {
  const directory = join(root, PRESET_ID)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'agent.cordis.yml'), '- id: ghost\n  name: \'@deepseek-ai/dsh-no-such-plugin\'\n')
  await writeFile(join(directory, 'preset.yml'), 'name: Renamed plugin\ndescription: Names a plugin that no longer resolves.\n')
}

describe.skipIf(MODE === 'record')('web e2e: refused New Session', () => {
  it('shows the Host refusal as a notice and leaves the Workspace without a Session', async () => {
    const presetRoot = await realpath(await mkdtemp(join(tmpdir(), 'dsh-web-e2e-broken-preset-')))
    onTestFinished(() => rm(presetRoot, { recursive: true, force: true }))
    await seedBrokenPreset(presetRoot)
    const scaffold = await launchWebScaffold({
      firstUse: true,
      agentPresets: { roots: [{ path: presetRoot, trust: 'user' }], default: PRESET_ID },
    })
    onTestFinished(() => scaffold.close())
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage({ locale: 'zh-CN', timezoneId: 'Asia/Shanghai' })
      const tripwire = watchConsole(page)
      try {
        await page.goto(scaffold.authenticatedUrl)
        // Startup prepares the default Workspace, and its own blank-Session
        // attempt is refused without a notice: the hero stays on the picker.
        await page.getByRole('button', { name: '选择工作区', exact: true }).waitFor()
        await expect.poll(() => scaffold.ctx.workspaceRegistry.list().length).toBe(1)
        expect(scaffold.ctx.sessions.list()).toEqual([])
        expect(await page.getByRole('alert').count()).toBe(0)

        await page.getByRole('button', { name: '新建会话', exact: true }).first().click()
        const notice = page.getByRole('alert').filter({ hasText: '新建会话失败' })
        await notice.waitFor()
        await compareOrRefreshGolden(NOTICE_EXPECTED, await notice.ariaSnapshot(), MODE)
        expect(scaffold.ctx.sessions.list()).toEqual([])
        expect(scaffold.ctx.workspaceRegistry.list()).toHaveLength(1)
        expect(await page.locator('[data-composer-input][contenteditable="true"]').count()).toBe(0)
        expect(tripwire.pageErrors).toEqual([])
        expect(tripwire.warnings).toEqual([])
      } catch (error) {
        await saveFailureShot(page, 'web-e2e-new-session-refused')
        throw error
      }
    } finally {
      await browser.close()
    }
  })
})
