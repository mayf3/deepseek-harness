/** Workspace keyboard commands over the real Web composition and a recorded Session. */
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold, readPersistedEvents,
  seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'

const root = fileURLToPath(new URL('./expected/shortcuts-workspace', import.meta.url))
const seed = fileURLToPath(new URL('../../../snapshots/web/seeded-history/session.v3.jsonl', import.meta.url))
const sourceId = SessionId('shortcuts-workspace-source')
const mode = webSnapshotMode()

describe.skipIf(mode === 'record')('web e2e: workspace shortcuts', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let previous: string | undefined
  const launched: { app: string; path: string }[] = []
  beforeAll(async () => {
    scaffold = await launchWebScaffold({ developerTools: false, openInAppEnvironment: createLaunchEnvironmentSnapshot([]) })
    await seedSession(scaffold, await readFile(seed, 'utf8'), sourceId)
    await mkdir(join(scaffold.workspaceCwd, 'keyboard-project'))
    browser = await chromium.launch()
    const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 1000 } })
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'platform', { value: 'MacIntel' })
      localStorage.setItem('dsh.open-in-app.choice', JSON.stringify('vscode'))
    })
    page = await context.newPage()
    // OS application discovery and launch are the external boundary; the command and HTTP carrier stay real.
    await page.route('**/open-in-app/apps', route => route.fulfill({ json: { apps: ['finder', 'vscode'] } }))
    await page.route('**/open-in-app/open', async (route) => {
      launched.push(route.request().postDataJSON() as { app: string; path: string })
      await route.fulfill({ json: { ok: true } })
    })
    const startup = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    const group = page.getByRole('treeitem').first()
    await group.waitFor({ timeout: 10_000 }).catch((error: unknown) => { throw new Error(JSON.stringify(startup), { cause: error }) })
    if (await group.getAttribute('aria-expanded') !== 'true') await group.click()
    await page.getByRole('treeitem').nth(1).click()
    await page.getByText('DONE', { exact: true }).waitFor()
  })
  afterAll(async () => { await browser?.close(); await scaffold?.close() })

  async function bind(label: string): Promise<void> {
    await page.keyboard.press('Meta+Slash')
    const reference = page.getByRole('dialog', { name: 'Keyboard shortcuts', exact: true })
    await reference.waitFor()
    if (['Rename session', 'Fork session', 'Archive session'].includes(label)) {
      const row = reference.getByRole('listitem').filter({ has: page.getByText(label, { exact: true }) })
      expect(await row.count()).toBe(1)
      expect(await row.getByText('Unavailable', { exact: true }).count()).toBe(0)
    }
    if (previous !== undefined) {
      await reference.getByRole('button', { name: `Remove shortcut for ${previous}`, exact: true }).click()
      await expect.poll(() => reference.getByRole('button', { name: `Remove shortcut for ${previous}`, exact: true }).count()).toBe(0)
    }
    await reference.getByRole('button', { name: `Edit shortcut for ${label}`, exact: true }).click()
    await page.keyboard.press('Meta+Shift+Comma')
    await expect.poll(() => reference.getByRole('group').count()).toBe(0)
    await page.keyboard.press('Escape')
    await reference.waitFor({ state: 'hidden' })
    previous = label
  }

  it('runs seven owner operations with saved bindings and preserves the completed fork prefix', async () => {
    const console = watchConsole(page)
    await bind('Search sessions')
    await page.keyboard.press('Meta+Shift+Comma')
    const search = page.getByPlaceholder('Search sessions...', { exact: true })
    await expect.poll(() => search.evaluate(element => element === document.activeElement)).toBe(true)
    expect(await page.getByRole('button', { name: 'Search sessions', exact: true }).getAttribute('aria-keyshortcuts')).toBe('Shift+Meta+,')
    await page.keyboard.press('Escape')

    await bind('Rename session')
    await page.keyboard.press('Meta+Shift+Comma')
    const rename = page.getByRole('dialog', { name: 'Rename session', exact: true })
    await rename.getByLabel('Session name').fill('T4 source')
    await rename.getByRole('button', { name: 'Rename', exact: true }).click()
    await rename.waitFor({ state: 'hidden' })
    await expect.poll(async () => (await readPersistedEvents(scaffold, sourceId)).some(event => event.type === 'session/title' && event.data.title === 'T4 source')).toBe(true)

    await bind('Fork session')
    const original = await readPersistedEvents(scaffold, sourceId)
    const lastEnd = original.findLastIndex(event => event.type === 'turn/end')
    await page.keyboard.press('Meta+Shift+Comma')
    await expect.poll(() => scaffold.ctx.agents.list().find(agent => agent.session.header.parentSession === sourceId)).toBeDefined()
    const child = scaffold.ctx.agents.list().find(agent => agent.session.header.parentSession === sourceId)!
    const childId = child.session.header.id
    await expect.poll(async () => (await readPersistedEvents(scaffold, childId)).some(event => event.type === 'session/title' && event.data.title === 'T4 source (1)')).toBe(true)
    const copied = await readPersistedEvents(scaffold, childId)
    expect(copied.slice(0, lastEnd + 1)).toEqual(original.slice(0, lastEnd + 1))
    await page.getByRole('treeitem', { selected: true }).filter({ hasText: 'T4 source (1)' }).waitFor()
    await compareOrRefreshGolden(join(root, 'fork.expected.md'),
      await captureStableAria(page, '[data-slot="sidebar.workspaces"]', scaffold.workspaceCwd), mode)

    await bind('Archive session')
    await page.getByRole('treeitem').filter({ has: page.getByText('T4 source', { exact: true }) }).hover()
    await page.getByRole('button', { name: 'Session actions for T4 source', exact: true }).click()
    await page.getByRole('menu').waitFor()
    await compareOrRefreshGolden(join(root, 'session-menu.expected.md'),
      await captureStableAria(page, '[role="menu"]', scaffold.workspaceCwd), mode)
    expect(await page.getByRole('menuitem', { name: /^Archive session/ }).getAttribute('aria-keyshortcuts')).toBe('Shift+Meta+,')
    await page.keyboard.press('Escape')
    await page.getByRole('menu').waitFor({ state: 'hidden' })
    await page.getByRole('treeitem', { selected: true }).filter({ hasText: 'T4 source (1)' }).waitFor()
    await page.keyboard.press('Meta+Shift+Comma')
    await expect.poll(() => scaffold.ctx.workspaceRegistry.archivedSessionIds).toContain(childId)
    expect((await readPersistedEvents(scaffold, sourceId)).length).toBeGreaterThan(0)

    await bind('Add workspace')
    await page.keyboard.press('Meta+Shift+Comma')
    const picker = page.getByRole('dialog', { name: 'Select Workspace Directory', exact: true })
    await picker.waitFor()
    await page.keyboard.press('Meta+Shift+Comma')
    expect(await page.getByRole('dialog', { name: 'Select Workspace Directory', exact: true }).count()).toBe(1)
    await picker.getByRole('button', { name: 'Edit path', exact: true }).click()
    await picker.getByRole('textbox', { name: 'Edit path', exact: true }).fill(join(scaffold.workspaceCwd, 'keyboard-project'))
    await page.keyboard.press('Enter')
    await picker.getByRole('button', { name: 'Open', exact: true }).click()
    await picker.waitFor({ state: 'hidden' })
    await expect.poll(() => scaffold.ctx.workspaceRegistry.resolveByPath(join(scaffold.workspaceCwd, 'keyboard-project'))).toBeDefined()
    const workspace = (await scaffold.ctx.workspaceRegistry.resolveByPath(join(scaffold.workspaceCwd, 'keyboard-project')))!

    await bind('New Session')
    await page.keyboard.press('Meta+Shift+Comma')
    await expect.poll(() => page.getByRole('treeitem', { selected: true }).textContent()).toContain('New Session')
    expect(workspace.sessionIds.length).toBe(1)

    await bind('Open locally')
    await page.keyboard.press('Meta+Shift+Comma')
    await expect.poll(() => launched).toEqual([{ app: 'vscode', path: workspace.path }])
    expect(console.pageErrors).toEqual([])
  })
})

it.each([
  { platform: 'Win32', primary: 'Control', file: 'windows-defaults', custom: 'Control+Alt+Shift+Meta+J' },
  { platform: 'MacIntel', primary: 'Meta', file: 'macos-defaults', custom: 'Meta+Alt+Shift+J' },
])('runs $platform defaults over recorded history and restores them after a multi-modifier binding', async ({ platform, primary, file, custom }) => {
  const scaffold = await launchWebScaffold({ developerTools: false })
  let browser: Browser | undefined
  try {
    await seedSession(scaffold, await readFile(seed, 'utf8'), SessionId('windows-shortcuts-source'))
    browser = await chromium.launch()
    const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 1000 } })
    await context.addInitScript((value) => { Object.defineProperty(navigator, 'platform', { value }) }, platform)
    const page = await context.newPage()
    const console = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    const group = page.getByRole('treeitem').first()
    await group.waitFor()
    if (await group.getAttribute('aria-expanded') !== 'true') await group.click()
    await page.getByRole('treeitem').nth(1).click()
    await page.getByText('DONE', { exact: true }).waitFor()
    await page.keyboard.press(`${primary}+Slash`)
    const reference = page.getByRole('dialog', { name: 'Keyboard shortcuts', exact: true })
    await reference.waitFor()
    await compareOrRefreshGolden(join(root, `${file}.expected.md`),
      await captureStableAria(page, '[data-shortcut-modal="shortcuts"]', scaffold.workspaceCwd), mode)
    await page.keyboard.press('Escape')
    await reference.waitFor({ state: 'hidden' })
    await page.keyboard.press(`${primary}+Alt+K`)
    const search = page.getByPlaceholder('Search sessions...', { exact: true })
    await expect.poll(() => search.evaluate(element => element === document.activeElement)).toBe(true)
    await page.keyboard.press('Escape')
    await page.keyboard.press(`${primary}+Alt+B`)
    await page.getByRole('button', { name: 'Open sidebar', exact: true }).waitFor()
    await page.keyboard.press(`${primary}+Alt+B`)
    await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).waitFor()
    await page.keyboard.press(`${primary}+Slash`)
    await reference.getByRole('button', { name: 'Edit shortcut for Toggle left sidebar', exact: true }).click()
    await page.keyboard.press(custom)
    await reference.getByRole('group').waitFor({ state: 'hidden' })
    await page.keyboard.press('Escape')
    await page.keyboard.press(custom)
    await page.getByRole('button', { name: 'Open sidebar', exact: true }).waitFor()
    await page.keyboard.press(custom)
    await page.keyboard.press(`${primary}+Slash`)
    await reference.getByRole('button', { name: 'Edit shortcut for Toggle left sidebar', exact: true }).click()
    await reference.getByRole('button', { name: 'Restore default', exact: true }).click()
    await reference.getByRole('group').waitFor({ state: 'hidden' })
    await page.keyboard.press('Escape')
    expect(await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).getAttribute('aria-keyshortcuts')).toBe(primary === 'Meta' ? 'Alt+Meta+B' : 'Control+Alt+B')
    if (platform === 'MacIntel') {
      await page.keyboard.press('Meta+Slash')
      await reference.getByRole('button', { name: 'Edit shortcut for New Session', exact: true }).click()
      const recorder = reference.getByRole('button', { name: 'Press a shortcut', exact: true })
      // Reproduce the macOS Dead-key payload through the real recorder and command owners.
      expect(await recorder.evaluate((element) => {
        const event = new KeyboardEvent('keydown', { key: 'Dead', code: 'KeyN', metaKey: true, altKey: true, bubbles: true, cancelable: true })
        element.dispatchEvent(event)
        element.dispatchEvent(new KeyboardEvent('keyup', { key: 'Meta', code: 'MetaLeft', bubbles: true }))
        return event.defaultPrevented
      })).toBe(true)
      await reference.getByRole('group').waitFor({ state: 'hidden' })
      await page.keyboard.press('Escape')
      const composer = page.locator('[data-composer-input]').first()
      await composer.focus()
      expect(await composer.evaluate((element) => {
        const event = new KeyboardEvent('keydown', { key: 'Dead', code: 'KeyN', metaKey: true, altKey: true, bubbles: true, cancelable: true })
        element.dispatchEvent(event)
        return event.defaultPrevented
      })).toBe(true)
    } else {
      await page.keyboard.press(`${primary}+Alt+N`)
    }
    await page.getByText('DONE', { exact: true }).waitFor({ state: 'hidden' })
    await expect.poll(() => page.getByRole('treeitem', { selected: true }).count()).toBe(0)
    await page.locator('[data-composer-input]').first().waitFor()
    expect(console.pageErrors).toEqual([])
  } finally {
    await browser?.close()
    await scaffold.close()
  }
})
