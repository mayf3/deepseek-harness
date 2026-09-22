// The real installer classifies a controlled GitHub network failure; the browser
// offers a mirror for a replacement spec without retrying the failed address.
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { launchWebScaffold, captureStableAria, compareOrRefreshGolden, webSnapshotMode, watchConsole } from './scaffold.ts'
import { ZH_BROWSER_LOCALE } from './support.ts'

it('offers a mirror after GitHub fails and waits for replacement input', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-install-github-'))
  onTestFinished(() => rm(scratch, { recursive: true, force: true }))
  const overlay = join(scratch, 'cordis.patch.yml')
  await writeFile(overlay, `- id: plugin-manager\n  config: ${JSON.stringify({ pnpmCommand: process.execPath })}\n`)
  const scaffold = await launchWebScaffold({ profile: { packages: [] }, extraOverlayPath: overlay })
  onTestFinished(() => scaffold.close())
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const profile = join(scaffold.harnessHome, 'profiles', 'scaffold')
  const manifestPath = join(profile, 'package.json')
  const manifestBefore = await readFile(manifestPath, 'utf8')
  await writeFile(join(profile, 'config'), 'console.log("https://registry.npmjs.org/")\n')
  await writeFile(join(profile, 'add'), `
    const fs = require('node:fs');
    fs.appendFileSync('.attempts', JSON.stringify(process.argv) + '\\n');
    console.error("fatal: unable to access 'https://github.com/example/dsh-plugin.git/': Could not resolve host: github.com");
    process.exitCode = 1;
  `)
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, locale: ZH_BROWSER_LOCALE })
  const tripwire = watchConsole(page)
  await page.goto(scaffold.authenticatedUrl)
  await page.waitForSelector('[class*="frame"]')
  if (await page.getByRole('dialog', { name: '设置' }).count() > 0) await page.keyboard.press('Escape')
  await page.getByRole('navigation', { name: '全局面板' }).getByRole('button', { name: '插件', exact: true }).click()
  await page.getByRole('button', { name: '添加插件', exact: true }).click()
  const spec = 'https://github.com/example/dsh-plugin.git'
  let dialog = page.getByRole('dialog', { name: '添加插件', exact: true })
  await dialog.getByRole('button', { name: '安装源 默认安装源', exact: true }).waitFor()
  await dialog.getByRole('textbox', { name: '包名或地址' }).fill(spec)
  expect(await page.getByText('无法访问 GitHub', { exact: true }).count()).toBe(0)
  await dialog.getByRole('button', { name: '安装', exact: true }).click()
  dialog = page.getByRole('dialog', { name: '无法访问 GitHub', exact: true })
  await dialog.waitFor()
  expect(await page.getByRole('dialog').count()).toBe(1)
  expect(await dialog.getByText('请尝试其他安装来源。', { exact: true }).count()).toBe(1)
  await compareOrRefreshGolden(
    fileURLToPath(new URL('./expected/plugin-install-github/failed.expected.md', import.meta.url)),
    await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd), webSnapshotMode(),
  )
  const attempts = await readFile(join(profile, '.attempts'), 'utf8')
  expect(attempts.trim().split('\n')).toHaveLength(1)
  await dialog.getByRole('button', { name: '改用国内镜像', exact: true }).click()
  dialog = page.getByRole('dialog', { name: '添加插件', exact: true })
  const input = dialog.getByRole('textbox', { name: '插件包名', exact: true })
  await input.waitFor()
  expect(await input.inputValue()).toBe('')
  expect(await input.evaluate(element => element === document.activeElement)).toBe(true)
  expect(await dialog.getByRole('button', { name: '安装', exact: true }).isDisabled()).toBe(true)
  await dialog.getByRole('button', { name: '安装源 中国大陆镜像源', exact: true }).waitFor()
  await compareOrRefreshGolden(
    fileURLToPath(new URL('./expected/plugin-install-github/mirror.expected.md', import.meta.url)),
    await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd), webSnapshotMode(),
  )
  expect(await readFile(join(profile, '.attempts'), 'utf8')).toBe(attempts)
  expect(await readFile(manifestPath, 'utf8')).toBe(manifestBefore)
  expect(await dialog.getByRole('button', { name: '恢复 GitHub 链接', exact: true }).count()).toBe(0)
  await input.fill(spec)
  await dialog.getByRole('button', { name: '安装', exact: true }).click()
  dialog = page.getByRole('dialog', { name: '无法访问 GitHub', exact: true })
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  await dialog.waitFor({ state: 'detached' })
  expect((await readFile(join(profile, '.attempts'), 'utf8')).trim().split('\n')).toHaveLength(2)
  expect(tripwire.pageErrors).toEqual([])
})
