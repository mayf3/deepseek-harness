/** A turn that edits, creates, and shell-appends files in a git workspace ends with the changed-files card. */
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type {} from '@deepseek-ai/dsh-workspace-changes'
import { deriveReplayScript, parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import {
  assertFinalWorkspaceSnapshot, captureExpandedTurnProcessAria, compareOrRefreshGolden,
  fixtureUserPrompts, launchWebScaffold, recordFixture, watchConsole,
  webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspaceZh, ZH_BROWSER_LOCALE } from './support.ts'

const DIR = fileURLToPath(new URL('../../../snapshots/web/changed-files-turn', import.meta.url))
const FIXTURE = join(DIR, 'session.v3.jsonl')
const MODE = webSnapshotMode()
const PROMPT = '不用先查看目录，直接做三件事：把 intro.md 里的标题「示例项目」改成「项目说明」，新建 src/util.ts 导出一个两数相加的 add 函数，然后用 bash 在 notes.txt 末尾追加一行 done。'

/** Seed a committed repository so the turn's own edits are the only difference between its snapshots. */
async function seedRepository(cwd: string): Promise<void> {
  await mkdir(cwd, { recursive: true })
  await writeFile(join(cwd, 'intro.md'), '# 示例项目\n\n一个用于演示的仓库。\n')
  await writeFile(join(cwd, 'notes.txt'), 'start\n')
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=seed@example.com', '-c', 'user.name=seed', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  git('add', '-A')
  git('commit', '-q', '-m', 'seed')
}

describe('web e2e: a git workspace turn ends with its changed files', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let cwd: string
  let replayRoot: string | undefined

  beforeAll(async () => {
    let replayOverride: string | undefined
    if (MODE !== 'record') {
      replayRoot = await mkdtemp(join(tmpdir(), 'dsh-changed-files-turn-replay-'))
      replayOverride = join(replayRoot, 'replay.override.json')
      const script = deriveReplayScript(parseSessionLog(await readFile(FIXTURE, 'utf8')))
      // Recorded absolute paths must follow each isolated Session's working directory.
      const cwdToken = '{{fromRequest:Your working directory is ([^\\n]+)\\.}}'
      await writeFile(replayOverride, JSON.stringify(script).replaceAll('{{cwd}}', JSON.stringify(cwdToken).slice(1, -1)))
    }
    scaffold = await launchWebScaffold({
      compareReplaySession: true,
      extraOverlayPath: fileURLToPath(new URL('./changed-files-turn.overlay.yml', import.meta.url)),
      ...(replayOverride === undefined ? {} : { replayFixture: FIXTURE, replayOverride }),
    })
    await seedRepository(join(scaffold.workspaceCwd, 'workspace'))
    browser = await chromium.launch()
    page = await browser.newPage({
      viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE, timezoneId: 'Asia/Shanghai',
    })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]')
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
  })

  afterAll(async () => {
    try {
      await browser?.close()
    } finally {
      try {
        await scaffold?.close()
      } finally {
        if (replayRoot !== undefined) await rm(replayRoot, { recursive: true, force: true })
      }
    }
  })

  it('records the edited, created, and shell-appended files with their line counts', async () => {
    if (MODE !== 'record') expect(fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))).toEqual([PROMPT])
    const settled = scaffold.whenTurnSettled()
    const input = page.locator('[data-composer-input]').first()
    await input.fill(PROMPT)
    await input.press('Enter')
    const sessionId = await settled
    const session = scaffold.ctx.agents.get(sessionId)?.session
    if (session?.header.cwd === undefined) throw new Error('changed-files Session has no workspace')
    cwd = session.header.cwd
    if (MODE === 'record') await recordFixture(scaffold, sessionId, FIXTURE)

    const summaries = session.snapshotEvents().filter(event => event.type === 'workspace/changes')
    const summary = summaries.at(-1)
    expect(summary, 'the turn must record its changed files').toBeDefined()
    if (summary === undefined) throw new Error('no changed-files summary')
    expect(summary.data.files.map(file => file.display)).toEqual(['intro.md', 'notes.txt', 'src/util.ts'])
    expect(summary.data.total).toBe(3)
    for (const file of summary.data.files) expect(file.added).toBeGreaterThan(0)
    expect(summary.data.files[1]).toMatchObject({ path: 'notes.txt', added: 1, deleted: 0 })
    expect(await readFile(join(cwd, 'notes.txt'), 'utf8')).toBe('start\ndone\n')

    const card = page.locator('[data-changed-files]')
    await card.waitFor({ state: 'visible' })
    expect(await card.getByText('已编辑 3 个文件', { exact: true }).count()).toBe(1)
    expect(await card.getByRole('listitem').count()).toBe(3)
    // Without a Host desktop the header is a label and rows preview in the Sidebar.
    expect(await card.getByRole('button', { name: '打开改动文件所在的文件夹' }).count()).toBe(0)
    expect(await card.getByRole('button', { name: '在侧边栏打开 notes.txt' }).count()).toBe(1)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })

  it.skipIf(MODE === 'record')('replays the workspace and the Chinese conversation', async () => {
    await assertFinalWorkspaceSnapshot(DIR, cwd, { ignoredRootEntries: ['.git'] })
    const aria = await captureExpandedTurnProcessAria(page, '[data-chat-flow]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(join(DIR, 'ui.expected.md'), aria, MODE)
  })
})
