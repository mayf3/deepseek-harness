/** Real application composition and Desktop persistence with a substituted Electron preload transport. */
import { mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { initialShortcutConfig, parseShortcutDefinitions, parseShortcutEdit } from '@deepseek-ai/dsh-client-shortcuts/protocol'
import type { DesktopShortcutInput, DesktopShortcutsApi, ShortcutRevision } from '@deepseek-ai/dsh-client-shortcuts/protocol'
import { desktopKeybindings } from '../../desktop/src/keybindings.ts'
import { compareOrRefreshGolden, launchWebScaffold, seedSession, watchConsole, webSnapshotMode } from './scaffold.ts'

type FixtureWindow = Window & {
  desktopShortcutsGet: DesktopShortcutsApi['get']
  desktopShortcutsEdit: DesktopShortcutsApi['edit']
  shortcutFixture: { deliver(input: DesktopShortcutInput): void; recording: boolean; closedWindows: number }
}

const expected = fileURLToPath(new URL('./expected/shortcuts-desktop', import.meta.url))
const seed = fileURLToPath(new URL('../../../snapshots/web/seeded-history/session.v3.jsonl', import.meta.url))
const mode = webSnapshotMode()

it.each([
  { platform: 'macos', marker: 'darwin', primary: 'Meta' },
  { platform: 'windows', marker: 'win32', primary: 'Control' },
] as const)('records, persists and prioritizes $platform Desktop single keys and chords over recorded history', async ({ platform, marker, primary }) => {
  const userData = await mkdtemp(join(tmpdir(), 'dsh-shortcuts-desktop-'))
  let snapshot = initialShortcutConfig()
  const persistence = desktopKeybindings(userData, platform, (value) => { snapshot = value })
  try {
    const scaffold = await launchWebScaffold({ developerTools: false })
    try {
      await seedSession(scaffold, await readFile(seed, 'utf8'), SessionId('desktop-shortcuts-source'))
      const browser = await chromium.launch()
      try {
        const page = await browser.newPage({ locale: 'en-US', viewport: { width: 1440, height: 1000 } })
        await page.exposeFunction('desktopShortcutsGet', async (definitions: unknown) => {
          persistence.setDefinitions(parseShortcutDefinitions(definitions))
          return persistence.readCurrent()
        })
        await page.exposeFunction('desktopShortcutsEdit', (edit: unknown, revision: ShortcutRevision) => persistence.edit(parseShortcutEdit(edit), revision))
        // Only the Electron transport is substituted; preference storage and all Client plugins are real.
        await page.addInitScript((device) => {
          const scope = window as unknown as FixtureWindow
          const mark = () => { document.documentElement.dataset.platform = device }
          if (document.documentElement === null) window.addEventListener('DOMContentLoaded', mark)
          else mark()
          const listeners = new Set<(input: DesktopShortcutInput) => void>()
          const fixture = { recording: false, closedWindows: 0,
            deliver(input: DesktopShortcutInput) { for (const listener of listeners) listener(input) },
          }
          Object.assign(window, { shortcutFixture: fixture, dshDesktop: { protocolVersion: 1,
            shortcuts: {
              get: scope.desktopShortcutsGet, edit: scope.desktopShortcutsEdit,
              recording: async (active: boolean) => { fixture.recording = active }, subscribe: () => () => {},
            },
            keyboard: { subscribe: (listener: (input: DesktopShortcutInput) => void) => {
              listeners.add(listener); return () => { listeners.delete(listener) }
            }, closeWindow: async () => { fixture.closedWindows++ } },
          } })
        }, marker)
        const console = watchConsole(page)
        await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
        const deliverPrimary = (code: string) => page.evaluate((input) => {
          (window as unknown as FixtureWindow).shortcutFixture.deliver(input)
        }, {
          kind: 'keyboard', frameName: '', revision: snapshot.revision, code,
          control: platform === 'windows', meta: platform === 'macos', alt: false, shift: false, repeat: false,
        } satisfies DesktopShortcutInput)
        const openReference = () => deliverPrimary('Slash')
        const group = page.getByRole('treeitem').first()
        await group.waitFor()
        if (await group.getAttribute('aria-expanded') !== 'true') await group.click()
        await page.getByRole('treeitem').nth(1).click()
        await page.getByText('DONE', { exact: true }).waitFor()
        const composer = page.locator('[data-composer-input]').first()
        await composer.focus()
        await page.keyboard.insertText('Desktop focus draft')
        const selectDraft = () => composer.evaluate((element) => {
          const text = element.querySelector('[data-lexical-text]')!.firstChild!
          document.getSelection()!.setBaseAndExtent(text, 0, text, 7)
        })
        await selectDraft()
        await deliverPrimary('KeyP')
        const panel = page.locator('[data-sidebar-right-panel][data-sidebar-right-open]')
        const files = panel.locator('[data-dockkit-tab]').filter({ hasText: 'Files' })
        await files.waitFor()
        expect(await panel.locator('[data-dockkit-pane]').evaluate(pane => document.activeElement === pane)).toBe(true)
        expect(await page.evaluate(() => document.getSelection()?.toString())).toBe('Desktop')
        await composer.focus()
        await selectDraft()
        await deliverPrimary('KeyP')
        expect(await files.count()).toBe(1)
        expect(await panel.locator('[data-dockkit-pane]').evaluate(pane => document.activeElement === pane)).toBe(true)
        expect(await page.evaluate(() => document.getSelection()?.toString())).toBe('Desktop')
        await deliverPrimary('KeyW')
        await expect.poll(() => page.locator('[data-sidebar-right-open]').count()).toBe(0)
        expect(await page.evaluate(() => (window as unknown as FixtureWindow).shortcutFixture.closedWindows)).toBe(0)
        expect(await composer.innerText()).toBe('Desktop focus draft')
        await composer.focus()
        await composer.fill('')
        await expect.poll(() => composer.textContent()).toBe('')
        await openReference()
        const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts', exact: true })
        const rowHeights = () => dialog.getByRole('listitem').evaluateAll(rows => rows.map(row => row.getBoundingClientRect().height))
        const heights = await rowHeights()
        expect(new Set(heights)).toEqual(new Set([42]))
        await dialog.getByRole('button', { name: 'Edit shortcut for New Session', exact: true }).click()
        await expect.poll(() => page.evaluate(() => (window as unknown as FixtureWindow).shortcutFixture.recording)).toBe(true)
        expect(await rowHeights()).toEqual(heights)
        const firstRecorder = dialog.getByRole('button', { name: 'Press a shortcut', exact: true })
        expect(await firstRecorder.evaluate(node => getComputedStyle(node).boxShadow)).toBe('none')
        expect(await dialog.getByRole('button', { name: 'Cancel recording', exact: true }).count()).toBe(0)
        await compareOrRefreshGolden(join(expected, `${platform}-recording.expected.md`), await dialog.getByRole('group').ariaSnapshot(), mode)
        await page.keyboard.press(`${primary}+C`)
        await dialog.getByRole('group').waitFor({ state: 'hidden' })
        const saved = JSON.parse(await readFile(join(userData, 'keybindings.json'), 'utf8')) as unknown
        expect(saved).toMatchObject({ schemaVersion: 2, profiles: { [`desktop:${platform}`]: {
          'session.new': { code: 'KeyC', modifiers: [platform === 'macos' ? 'meta' : 'control'] },
        } } })
        await page.reload({ waitUntil: 'load' })
        await page.getByText('DONE', { exact: true }).waitFor()
        await openReference()
        await dialog.getByRole('searchbox').fill('New Session')
        const row = dialog.getByRole('listitem')
        await expect.poll(() => row.count()).toBe(1)
        await compareOrRefreshGolden(join(expected, `${platform}-copy-override.expected.md`), await row.ariaSnapshot(), mode)
        await page.keyboard.press('Escape')
        await dialog.waitFor({ state: 'hidden' })
        await composer.focus()
        await page.evaluate((input) => { (window as unknown as FixtureWindow).shortcutFixture.deliver(input) }, {
          kind: 'keyboard', frameName: '', revision: snapshot.revision, code: 'KeyC',
          control: platform === 'windows', meta: platform === 'macos', alt: false, shift: false, repeat: false,
        } satisfies DesktopShortcutInput)
        await page.getByText('DONE', { exact: true }).waitFor({ state: 'hidden' })
        await expect.poll(() => page.getByRole('treeitem', { selected: true }).count()).toBe(0)
        await page.getByRole('treeitem').nth(1).click()
        await page.getByText('DONE', { exact: true }).waitFor()
        await openReference()
        await dialog.getByRole('searchbox').fill('New Session')
        for (const code of ['a', 'F1', 'ArrowLeft', 'Tab']) {
          await dialog.getByRole('button', { name: 'Edit shortcut for New Session', exact: true }).click()
          const recorder = dialog.getByRole('button', { name: 'Press a shortcut', exact: true })
          await expect.poll(() => recorder.isEnabled()).toBe(true)
          await recorder.focus()
          await page.keyboard.press(code)
          await dialog.getByRole('group').waitFor({ state: 'hidden' })
          expect(snapshot.document.profiles[`desktop:${platform}`]?.['session.new']).toEqual({
            code: code === 'a' ? 'KeyA' : code, modifiers: [],
          })
        }
        await dialog.getByRole('button', { name: 'Edit shortcut for New Session', exact: true }).click()
        const recorder = dialog.getByRole('button', { name: 'Press a shortcut', exact: true })
        await expect.poll(() => recorder.isEnabled()).toBe(true)
        await recorder.focus()
        const accepted = snapshot.document
        for (const key of [`${primary}+Slash`, 'Escape', 'Enter', 'ArrowUp', 'ArrowDown', 'Shift+Enter', `${primary}+Enter`, 'Slash', 'Shift+Digit2']) {
          expect(await recorder.evaluate(node => node === document.activeElement)).toBe(true)
          const keys = key.split('+')
          for (const held of keys) await page.keyboard.down(held)
          await expect.poll(() => recorder.getAttribute('aria-invalid')).toBe('false')
          expect(await recorder.textContent()).not.toBe('Press a shortcut')
          for (const held of keys.toReversed()) await page.keyboard.up(held)
          await expect.poll(() => recorder.getAttribute('aria-invalid')).toBe('true')
          if (key === `${primary}+Slash`) {
            await dialog.getByText('Already used by “Open keyboard shortcuts”', { exact: true }).waitFor()
          }
          expect(await recorder.evaluate(node => node === document.activeElement)).toBe(true)
          expect(snapshot.document).toEqual(accepted)
          expect(await dialog.getByRole('listitem').evaluateAll(rows => rows.map(row => row.getBoundingClientRect().height)))
            .toEqual([42])
        }
        await compareOrRefreshGolden(join(expected, `${platform}-fixed-conflict.expected.md`), await dialog.getByRole('group').ariaSnapshot(), mode)
        const preferencePath = join(userData, 'keybindings.json')
        const savedPreferencePath = join(userData, 'keybindings.saved.json')
        await rename(preferencePath, savedPreferencePath)
        try {
          // A directory prevents atomic file replacement on every supported filesystem.
          await mkdir(preferencePath)
          await page.keyboard.press('j')
          await dialog.getByText('Could not save. Your previous shortcuts and current draft are preserved. Please retry.', { exact: true }).waitFor()
          expect(snapshot.document).toEqual(accepted)
          expect(await recorder.getAttribute('aria-invalid')).toBe('true')
          expect(await recorder.evaluate(node => node === document.activeElement)).toBe(true)
        } finally {
          await rm(preferencePath, { recursive: true, force: true })
          await rename(savedPreferencePath, preferencePath)
        }
        await page.keyboard.down('b')
        await page.keyboard.down('a')
        await expect.poll(() => recorder.getAttribute('aria-invalid')).toBe('false')
        expect(await recorder.textContent()).toContain('A')
        expect(await recorder.textContent()).toContain('B')
        await page.keyboard.up('a')
        await page.keyboard.up('b')
        await dialog.getByRole('group').waitFor({ state: 'hidden' })
        expect(snapshot.document.profiles[`desktop:${platform}`]?.['session.new']).toEqual({ code: 'KeyA', secondCode: 'KeyB', modifiers: [] })
        await compareOrRefreshGolden(join(expected, `${platform}-chord.expected.md`), await dialog.getByRole('listitem').ariaSnapshot(), mode)
        await page.reload({ waitUntil: 'load' })
        await page.getByText('DONE', { exact: true }).waitFor()
        await composer.focus()
        await page.keyboard.press('a'); await page.keyboard.press('b')
        await expect.poll(() => composer.textContent()).toBe('ab')
        await expect.poll(() => page.getByText('DONE', { exact: true }).isVisible()).toBe(true)
        await page.keyboard.down('a')
        await expect.poll(() => composer.textContent()).toBe('aba')
        await page.evaluate((input) => { (window as unknown as FixtureWindow).shortcutFixture.deliver(input) }, {
          kind: 'keyboard', frameName: '', revision: snapshot.revision, code: 'KeyA', secondCode: 'KeyB',
          control: false, meta: false, alt: false, shift: false, repeat: false,
        } satisfies DesktopShortcutInput)
        await page.keyboard.up('a')
        await page.getByText('DONE', { exact: true }).waitFor({ state: 'hidden' })
        await expect.poll(() => page.getByRole('treeitem', { selected: true }).count()).toBe(0)
        expect(console.pageErrors).toEqual([])
        expect(console.warnings).toEqual([])
      } finally { await browser.close() }
    } finally { await scaffold.close() }
  } finally {
    persistence.dispose()
    await rm(userData, { recursive: true, force: true })
  }
})
