/** Shipped sidebar terminal over the real Loader, Remote mux, Chromium and local PTY. */
import { mkdir } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-api-terminal-controller'
import { compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const expected = fileURLToPath(new URL('./expected/sidebar-terminal/running.expected.md', import.meta.url))
const shots = fileURLToPath(new URL('../../../.artifacts/screenshots/sidebar-terminal/', import.meta.url))

async function openTerminal(page: Page): Promise<void> {
  const expand = page.locator('[data-sidebar-right-expand]')
  if (await expand.isVisible()) await expand.click()
  else await page.locator('[data-dockkit-add-tab]').click()
  await page.locator('[data-sidebar-right-guide-entry="terminal"]').click()
  await expect.poll(async () => await page.locator('.xterm-rows:visible').innerText()).toContain('bash-')
}

async function command(page: Page, text: string): Promise<void> {
  await page.locator('.xterm-helper-textarea:visible').click()
  await page.keyboard.insertText(text)
  await page.keyboard.press('Enter')
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    // A container's init may retain a reparented zombie; it cannot run after terminal cleanup.
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3)
      return state !== 'Z' && state !== 'X'
    }
    return true
  } catch (error) {
    if (['ESRCH', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '')) return false
    throw error
  }
}

describe.skipIf(process.platform === 'win32')('Web sidebar terminal', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ extraOverlayPath: fileURLToPath(new URL('./fixtures/sidebar-terminal.patch.yml', import.meta.url)) })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    const agent = scaffold.ctx.agents.list()[0]
    if (agent === undefined) throw new Error('Workspace did not create a Session')
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Open a terminal.' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    agent.session.append('step/start', { turn: 1, step: 1 })
    agent.session.append('assistant/message', { stream: [], turn: 1, step: 1, message: createMessage({ role: 'assistant', content: [{ type: 'text', text: 'Ready for terminal input.' }], source: { kind: 'model', provider: 'fixture', model: 'fixture' } }) }, { surfaceOp: 'append' })
    agent.session.append('step/end', { turn: 1, step: 1 })
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await scaffold.ctx.sessions.flush(agent.session)
    await page.getByText('Ready for terminal input.').waitFor()
    await mkdir(shots, { recursive: true })
  }, 180_000)

  afterAll(async () => { await browser?.close(); await scaffold?.close() })

  it('completes commands, preserves the process through collapse and reload, resizes, and kills on tab close', async () => {
    onTestFailed(() => saveFailureShot(page, 'sidebar-terminal'))
    await openTerminal(page)
    const terminal = page.locator('[data-sidebar-terminal]')
    await command(page, "PS1=''; printf '\\033cTERMINAL_READY\\n'")
    const screen = page.locator('.xterm-rows:visible')
    await expect.poll(async () => await screen.innerText()).toContain('TERMINAL_READY')
    const aria = await terminal.ariaSnapshot()
    await compareOrRefreshGolden(expected, aria, webSnapshotMode())
    await command(page, "printf 'DSH_PID:%s\\n' \"$$\"")
    await expect.poll(async () => await screen.innerText()).toMatch(/DSH_PID:\d+/u)
    const pid = Number((await screen.innerText()).match(/DSH_PID:(\d+)/u)?.[1])
    expect(alive(pid)).toBe(true)
    await command(page, 'dsh_terminal_completion_probe(){ printf "completed_from_shell\\n"; }')
    await page.keyboard.press('Control+l')
    await page.keyboard.insertText('dsh_terminal_completion_pro')
    await page.keyboard.press('Tab')
    await page.keyboard.press('Enter')
    await expect.poll(async () => await screen.innerText()).toContain('completed_from_shell')
    await command(page, "printf 'PERSIST:%s\\n' \"$TERM\"")
    await expect.poll(async () => await screen.innerText()).toContain('PERSIST:xterm-256color')
    await page.locator('[data-dockkit-tab-title]').getByText('bash', { exact: true }).dblclick()
    await page.getByRole('textbox', { name: 'Terminal name', exact: true }).fill('Development')
    await page.getByRole('textbox', { name: 'Terminal name', exact: true }).press('Enter')
    await expect.poll(async () => await page.locator('[data-dockkit-tab-title]').allInnerTexts()).toContain('Development')
    await openTerminal(page)
    await command(page, "printf 'SECOND_PID:%s\\n' \"$$\"")
    await expect.poll(async () => await screen.innerText()).toMatch(/SECOND_PID:\d+/u)
    const secondPid = Number((await screen.innerText()).match(/SECOND_PID:(\d+)/u)?.[1])
    expect(secondPid).not.toBe(pid)
    await page.locator('[data-dockkit-tab]').filter({ hasText: 'Development' }).click()
    await expect.poll(async () => await screen.innerText()).toContain('PERSIST:xterm-256color')
    expect(alive(secondPid)).toBe(true)
    await page.getByRole('button', { name: 'Collapse right sidebar', exact: true }).click()
    expect(alive(pid)).toBe(true)
    await page.locator('[data-sidebar-right-expand]').click()
    const terminals = () => scaffold.ctx.terminalController.list(scaffold.ctx.agents.list()[0]!)
    const dockedCols = terminals()[0]!.cols
    await page.getByRole('button', { name: 'Fullscreen', exact: true }).click()
    await expect.poll(() => terminals()[0]!.cols).toBeGreaterThan(dockedCols)
    await command(page, "printf 'SIZE:'; stty size")
    await expect.poll(async () => await screen.innerText()).toContain(`SIZE:${terminals()[0]!.rows} ${terminals()[0]!.cols}`)
    await page.screenshot({ path: `${shots}/fullscreen.png`, fullPage: true })
    await page.reload({ waitUntil: 'load' })
    await page.locator('[data-dockkit-tab]').filter({ hasText: 'Development' }).waitFor({ timeout: 15_000 })
    await expect.poll(async () => await page.locator('[data-dockkit-tab-title]').allInnerTexts()).toEqual(['Start', 'Development', 'bash'])
    expect(terminals()).toHaveLength(2)
    expect(alive(pid)).toBe(true)
    expect(alive(secondPid)).toBe(true)
    await expect.poll(async () => await screen.innerText()).toContain(`SECOND_PID:${secondPid}`)
    const secondTab = page.locator('[data-dockkit-tab]').filter({ hasText: 'bash' })
    await secondTab.hover()
    await secondTab.locator('[data-dockkit-tab-close]').click()
    await expect.poll(async () => await secondTab.count()).toBe(0)
    await expect.poll(() => alive(secondPid), { timeout: 10_000 }).toBe(false)
    await expect.poll(async () => await screen.innerText()).toContain('PERSIST:xterm-256color')
    await command(page, "printf 'RECOVERED_PID:%s\\n' \"$$\"")
    await expect.poll(async () => await screen.innerText()).toContain(`RECOVERED_PID:${pid}`)
    await page.screenshot({ path: `${shots}/recovered.png`, fullPage: true })
    await command(page, "sleep 120 & printf 'CHILD_PID:%s\\n' $!")
    await expect.poll(async () => await screen.innerText()).toMatch(/CHILD_PID:\d+/u)
    const childPid = Number((await screen.innerText()).match(/CHILD_PID:(\d+)/u)?.[1])
    expect(alive(childPid)).toBe(true)
    const tab = page.locator('[data-dockkit-tab]').filter({ hasText: 'Development' })
    await tab.hover()
    await tab.locator('[data-dockkit-tab-close]').click()
    await expect.poll(() => alive(pid), { timeout: 10_000 }).toBe(false)
    await expect.poll(() => alive(childPid), { timeout: 10_000 }).toBe(false)
    await expect.poll(() => scaffold.ctx.terminalController.list(scaffold.ctx.agents.list()[0]!).length).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
  })
})
