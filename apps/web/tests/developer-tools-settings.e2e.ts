/** Shared settings are off on a fresh Host and survive browser reload through the ordinary settings UI. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { launchWebScaffold } from './scaffold.ts'
import { openSettingsFromAccountMenu, newEnglishPage } from './support.ts'

it('persists developer tools in the Host settings document and restores the accepted choice', async () => {
  const scaffold = await launchWebScaffold({ developerTools: false })
  onTestFinished(() => scaffold.close())
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  await page.goto(scaffold.authenticatedUrl)
  await openSettingsFromAccountMenu(page, 'en')
  const toggle = page.getByRole('switch', { name: 'Developer tools' })
  expect(await toggle.getAttribute('aria-checked')).toBe('false')
  expect(await readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8')).not.toContain('ui-developer-tools:')
  await toggle.click()
  await expect.poll(() => toggle.getAttribute('aria-checked')).toBe('true')
  expect(await readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8')).toContain('ui-developer-tools:\n  enabled: true')
  await page.reload()
  await openSettingsFromAccountMenu(page, 'en')
  await expect.poll(() => toggle.getAttribute('aria-checked')).toBe('true')
  await toggle.click()
  await expect.poll(() => toggle.getAttribute('aria-checked')).toBe('false')
  expect(await readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8')).toContain('ui-developer-tools:\n  enabled: false')
})
