/** First-use messages prepare a durable Workspace through the shipped Web composition. */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { describe, expect, it } from 'vitest'
import {
  captureStableAria, compareOrRefreshGolden, fixtureUserPrompts, launchWebScaffold,
  selectedSessionFixture, watchConsole, webSnapshotMode,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const FIXTURE = fileURLToPath(new URL('../../../snapshots/web/fresh-round-trip/session.v3.jsonl', import.meta.url))
const EXPECTED = fileURLToPath(new URL('../../../snapshots/web/default-workspace/ui.expected.md', import.meta.url))
const FAILURE_EXPECTED = fileURLToPath(new URL('./expected/default-workspace/failure.expected.md', import.meta.url))
const MODE = webSnapshotMode()

describe.skipIf(MODE === 'record')('web e2e: default Workspace', () => {
  it('sends the first draft in a newly selected default Workspace and keeps its identity across reload', async () => {
    const fixture = await selectedSessionFixture(FIXTURE)
    const scaffold = await launchWebScaffold({
      replayFixture: fixture,
      // The shared recording remains read-only; replay compares the complete persisted Session.
      compareReplaySession: MODE === 'replay',
      paceMs: 5,
    })
    try {
      const browser = await chromium.launch()
      try {
        const page = await newEnglishPage(browser)
        const tripwire = watchConsole(page)
        try {
          await page.goto(scaffold.authenticatedUrl)
          const input = page.locator('[data-composer-input][contenteditable="true"]').first()
          await input.waitFor()
          const prompt = fixtureUserPrompts(await readFile(fixture, 'utf8'))[0]!
          await input.fill(prompt)
          expect(scaffold.ctx.workspaceRegistry.list()).toEqual([])
          expect(scaffold.ctx.sessions.list()).toEqual([])
          const settled = scaffold.whenTurnSettled()
          await input.press('Enter')
          const sessionId = await settled
          const workspace = scaffold.ctx.workspaceRegistry.list()[0]!
          expect(workspace.title).toBe('Default workspace')
          expect(workspace.path).toBe(join(scaffold.workspaceCwd, 'Documents', 'deepseek-harness', 'Default workspace'))
          expect((await stat(workspace.path)).isDirectory()).toBe(true)
          expect(workspace.sessionIds).toContain(sessionId)
          expect(scaffold.ctx.sessions.get(sessionId)?.header.cwd).toBe(workspace.path)
          await page.getByText('DONE', { exact: true }).waitFor()
          await compareOrRefreshGolden(EXPECTED, await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd), MODE)
          await page.reload()
          await page.getByText('DONE', { exact: true }).waitFor()
          expect(scaffold.ctx.workspaceRegistry.list().map(item => item.id)).toEqual([workspace.id])
          expect(tripwire.pageErrors).toEqual([])
          expect(tripwire.warnings).toEqual([])
        } catch (error) {
          await saveFailureShot(page, 'web-e2e-default-workspace')
          throw error
        }
      } finally {
        await browser.close()
      }
    } finally {
      await scaffold.close()
    }
  })

  it('keeps the draft on a directory conflict and opens the composed folder picker for recovery', async () => {
    const scaffold = await launchWebScaffold()
    try {
      const parent = join(scaffold.workspaceCwd, 'Documents', 'deepseek-harness')
      await mkdir(parent, { recursive: true })
      await writeFile(join(parent, '默认工作区'), 'occupied')
      const chosen = join(scaffold.workspaceCwd, 'chosen')
      await mkdir(chosen)
      const browser = await chromium.launch()
      try {
        const page = await browser.newPage({ locale: 'zh-CN', timezoneId: 'Asia/Shanghai' })
        const tripwire = watchConsole(page)
        try {
          await page.goto(scaffold.authenticatedUrl)
          const input = page.locator('[data-composer-input][contenteditable="true"]').first()
          await input.fill('保留这条消息')
          await input.press('Enter')
          const modal = page.getByRole('dialog', { name: '无法创建默认工作区' })
          await modal.waitFor()
          await expect.poll(() => input.textContent()).toBe('保留这条消息')
          expect(scaffold.ctx.workspaceRegistry.list()).toEqual([])
          expect(scaffold.ctx.sessions.list()).toEqual([])
          await compareOrRefreshGolden(FAILURE_EXPECTED, await modal.ariaSnapshot(), MODE)
          await modal.getByRole('button', { name: '取消', exact: true }).click()
          expect(await input.textContent()).toBe('保留这条消息')
          await input.press('Enter')
          await modal.getByRole('button', { name: '选择文件夹', exact: true }).click()
          const picker = page.getByRole('dialog', { name: '选择工作区目录' })
          await picker.waitFor()
          await picker.getByRole('button', { name: '编辑路径', exact: true }).click()
          await picker.getByRole('textbox', { name: '编辑路径' }).fill(chosen)
          await page.keyboard.press('Enter')
          await picker.getByRole('button', { name: '打开', exact: true }).click()
          await picker.waitFor({ state: 'hidden' })
          await expect.poll(() => scaffold.ctx.workspaceRegistry.list().length).toBe(1)
          await page.getByRole('treeitem', { name: '新会话', exact: true }).waitFor()
          await expect.poll(() => input.textContent()).toBe('保留这条消息')
          expect(scaffold.ctx.workspaceRegistry.list()[0]?.path).toBe(chosen)
          expect(scaffold.ctx.sessions.list()).toHaveLength(1)
          expect(scaffold.ctx.sessions.list().every(session =>
            session.snapshotEvents().every(event => event.type !== 'user/message'))).toBe(true)
          expect(tripwire.pageErrors).toEqual([])
          expect(tripwire.warnings).toEqual([])
        } catch (error) {
          await saveFailureShot(page, 'web-e2e-default-workspace-failure')
          throw error
        }
      } finally {
        await browser.close()
      }
    } finally {
      await scaffold.close()
    }
  })
})
