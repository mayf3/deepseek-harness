/** Shared settings are off on a fresh Host and survive browser reload through the ordinary settings UI. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { launchWebScaffold } from './scaffold.ts'
import { newEnglishPage } from './support.ts'

it('persists developer tools in the Host settings document and restores the accepted choice', async () => {
  const scaffold = await launchWebScaffold({ developerTools: false })
  onTestFinished(() => scaffold.close())
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  await page.goto(scaffold.authenticatedUrl)
  await page.getByRole('button', { name: 'Account menu', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'General', exact: true }).click()
  const toggle = page.getByRole('switch', { name: 'Developer tools' })
  expect(await toggle.getAttribute('aria-checked')).toBe('false')
  expect(await readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8')).not.toContain('ui-developer-tools:')
  await toggle.click()
  await expect.poll(() => toggle.getAttribute('aria-checked')).toBe('true')
  expect(await readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8')).toContain('ui-developer-tools:\n  enabled: true')
  await page.reload()
  await page.getByRole('button', { name: 'Account menu', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'General', exact: true }).click()
  await expect.poll(() => toggle.getAttribute('aria-checked')).toBe('true')
  await toggle.click()
  await expect.poll(() => toggle.getAttribute('aria-checked')).toBe('false')
  expect(await readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8')).toContain('ui-developer-tools:\n  enabled: false')

  await page.getByRole('button', { name: 'Agent presets', exact: true }).click()
  const pickerToggle = page.getByRole('switch', { name: 'Allow switching Agent modes' })
  await expect.poll(() => page.getByRole('heading', { name: 'Agent presets', exact: true }).count()).toBe(1)
  expect(await pickerToggle.count()).toBe(0)
  await scaffold.ctx.settings.update('ui-developer-tools', { enabled: true })
  await expect.poll(() => pickerToggle.count()).toBe(1)
  const pickerEnabled = await pickerToggle.getAttribute('aria-checked')
  await scaffold.ctx.settings.update('ui-developer-tools', { enabled: false })
  await expect.poll(() => pickerToggle.count()).toBe(0)
  await scaffold.ctx.settings.update('ui-developer-tools', { enabled: true })
  await expect.poll(() => pickerToggle.getAttribute('aria-checked')).toBe(pickerEnabled)
})
