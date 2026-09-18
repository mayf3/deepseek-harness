/** A turn that edits, creates, and shell-appends files in a git workspace ends with the changed-files card; its rows open the review. */
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
const PROMPT = '不用先查看目录，直接做四件事：把 intro.md 里的标题「示例项目」改成「项目说明」，新建 src/util.ts 导出一个两数相加的 add 函数，新建 app.local 写一行 mode=demo，最后用 bash 在 notes.txt 末尾追加一行 done。'

/** Seed a committed repository so the turn's own edits are the only difference between its snapshots; `*.local` stays ignored. */
async function seedRepository(cwd: string): Promise<void> {
  await mkdir(cwd, { recursive: true })
  await writeFile(join(cwd, 'intro.md'), '# 示例项目\n\n一个用于演示的仓库。\n')
  await writeFile(join(cwd, 'notes.txt'), 'start\n')
  await writeFile(join(cwd, '.gitignore'), '*.local\n')
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
      developerTools: false,
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

    const announced = session.snapshotEvents().filter(event => event.type === 'workspace/changes').at(-1)
    expect(announced, 'the turn must announce its changed files').toBeDefined()
    if (announced === undefined) throw new Error('no changed-files announcement')
    expect(announced.data).toEqual({ turn: 1 })
    // The log carries only the turn; the Host serves the summary for the announcing event while the Session lives.
    const summary = scaffold.ctx.workspaceChanges.summary(sessionId, announced.seq)
    if (summary === undefined) throw new Error('the Host serves no summary for the announcement')
    // app.local is ignored by the repository, so its counts come from the write call rather than git.
    expect(summary.files.map(file => file.display)).toEqual(['app.local', 'intro.md', 'notes.txt', 'src/util.ts'])
    expect(summary.total).toBe(4)
    for (const file of summary.files) expect(file.added).toBeGreaterThan(0)
    expect(summary.files[0]).toMatchObject({ path: 'app.local', added: 1, deleted: 0 })
    expect(summary.files[2]).toMatchObject({ path: 'notes.txt', added: 1, deleted: 0 })
    expect(await readFile(join(cwd, 'notes.txt'), 'utf8')).toBe('start\ndone\n')

    const card = page.locator('[data-changed-files]')
    expect(await card.count()).toBe(0)
    const header = page.locator('header').filter({ has: page.locator('[data-conversation-header-leading]') })
    expect(await header.getByRole('tablist').count()).toBe(0)
    const compactHeight = await header.evaluate(element => element.getBoundingClientRect().height)
    expect(compactHeight).toBeLessThan(60)
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const settings = page.getByRole('dialog', { name: '设置' })
    await settings.getByRole('switch', { name: '开发者工具' }).click()
    await expect.poll(() => settings.getByRole('switch', { name: '开发者工具' }).getAttribute('aria-checked')).toBe('true')
    await settings.getByRole('button', { name: '关闭', exact: true }).click()
    await header.getByRole('tablist').waitFor({ state: 'visible' })
    expect(await header.evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThan(compactHeight)
    await card.waitFor({ state: 'visible' })
    expect(await card.getByText('已编辑 4 个文件', { exact: true }).count()).toBe(1)
    expect(await card.getByRole('listitem').count()).toBe(3)
    expect(await card.getByRole('button', { name: '展开全部 4 个改动文件' }).count()).toBe(1)
    // The header and every row open the turn's review in the Sidebar, with or without a Host desktop.
    expect(await card.getByRole('button', { name: '在侧边栏查看本轮改动' }).count()).toBe(1)
    expect(await card.getByRole('button', { name: '查看 notes.txt 的改动' }).count()).toBe(1)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })

  it('reviews a shell-appended file from the snapshots and an ignored file from its captured copies in one tab', async () => {
    const card = page.locator('[data-changed-files]')
    const column = page.locator('[data-rightbar-col]')
    const drawn = (root: ReturnType<typeof column.locator>) =>
      root.locator('[data-diff-line]').evaluateAll(lines => lines.map(line => `${line.getAttribute('data-diff-line')}:${line.textContent}`))
    const review = column.locator('[data-changes-review]')
    // The header lands on the first listed file; a row lands on its own.
    await card.getByRole('button', { name: '在侧边栏查看本轮改动' }).click()
    await review.locator('[data-review-file="app.local"]').waitFor({ state: 'visible' })
    await card.getByRole('button', { name: '查看 notes.txt 的改动' }).click()
    await review.locator('[data-review-file="notes.txt"]').waitFor({ state: 'visible' })
    expect(await column.locator('[data-dockkit-tab]').filter({ hasText: '第 1 轮改动' }).count()).toBe(1)
    await expect.poll(() => drawn(review)).toEqual(['context:11 start', 'add:2+done'])
    // The ignored file has no snapshot; its comparison comes from the copies captured around the write call.
    await review.getByRole('button', { name: '选择要查看的文件' }).click()
    await page.getByRole('menuitem').filter({ hasText: 'app.local' }).click()
    await review.locator('[data-review-file="app.local"]').waitFor({ state: 'visible' })
    await expect.poll(() => drawn(review)).toEqual(['add:1+mode=demo'])
    expect(await review.getByText('本轮新建的文件').count()).toBe(1)
    // A card row opens the same tab on another file; the split and wrap choices switch the drawing.
    await card.getByRole('button', { name: '查看 intro.md 的改动' }).click()
    await review.locator('[data-review-file="intro.md"]').waitFor({ state: 'visible' })
    expect(await column.locator('[data-dockkit-tab]').filter({ hasText: '第 1 轮改动' }).count()).toBe(1)
    await review.getByRole('button', { name: '左右对比' }).click()
    await review.locator('[data-review-view="split"]').waitFor({ state: 'visible' })
    await expect.poll(() => drawn(review.locator('[data-diff-side="left"]'))).toEqual(['del:1# 示例项目', 'context:2', 'context:3一个用于演示的仓库。'])
    expect(await drawn(review.locator('[data-diff-side="right"]'))).toEqual(['del:1# 项目说明', 'context:2', 'context:3一个用于演示的仓库。'])
    // Constrain the recorded three-row diff to exercise unequal horizontal ranges and classic scrollbars.
    const scrollLayout = await page.addStyleTag({ content: `
      [data-changes-review] { height: 120px !important; }
      [data-diff-side] { scrollbar-width: auto; }
      [data-diff-side]::-webkit-scrollbar { width: 16px; height: 16px; }
      [data-diff-side="left"] { width: 65px; }
    ` })
    try {
      const left = review.locator('[data-diff-side="left"]')
      const right = review.locator('[data-diff-side="right"]')
      const metrics = (side: typeof left) => side.evaluate(element => ({
        x: element.scrollLeft, y: element.scrollTop,
        maxX: element.scrollWidth - element.clientWidth,
        maxY: element.scrollHeight - element.clientHeight,
        bottom: element.lastElementChild!.getBoundingClientRect().bottom,
      }))
      const initialLeft = await metrics(left)
      const initialRight = await metrics(right)
      expect(initialLeft.maxX).toBeGreaterThan(0)
      expect(initialRight.maxX).toBe(0)
      expect(initialLeft.maxY).toBeGreaterThan(0)
      expect(initialLeft.maxY).toBe(initialRight.maxY)
      await left.evaluate((element) => { element.scrollLeft = element.scrollWidth })
      await expect.poll(async () => (await metrics(left)).x).toBe(initialLeft.maxX)
      await left.evaluate((element) => { element.scrollTop = element.scrollHeight })
      await expect.poll(async () => (await metrics(right)).y).toBe(initialLeft.maxY)
      // Two frames allow the browser-generated peer event to run before checking the source.
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
      expect((await metrics(left)).x).toBe(initialLeft.maxX)
      expect((await metrics(left)).y).toBe(initialLeft.maxY)
      expect((await metrics(left)).bottom).toBeCloseTo((await metrics(right)).bottom, 1)
      await right.evaluate((element) => { element.scrollTop = 0 })
      await expect.poll(async () => (await metrics(left)).y).toBe(0)
      expect((await metrics(left)).x).toBe(initialLeft.maxX)
    } finally {
      await scrollLayout.evaluate(element => element.remove())
    }
    await review.getByRole('button', { name: '自动换行' }).click()
    await review.locator('[data-review-view][data-review-wrap]').waitFor({ state: 'visible' })
    await expect.poll(() => drawn(review)).toEqual(['del:1# 示例项目1# 项目说明', 'context:22', 'context:3一个用于演示的仓库。3一个用于演示的仓库。'])
    // No desktop, so the tools offer the sidebar file but no native open.
    expect(await review.locator('[data-review-tool="open-file"]').count()).toBe(1)
    expect(await review.locator('[data-review-tool="open-native"]').count()).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })

  it.skipIf(MODE === 'record')('replays the workspace and the Chinese conversation', async () => {
    await assertFinalWorkspaceSnapshot(DIR, cwd, { ignoredRootEntries: ['.git'] })
    const aria = await captureExpandedTurnProcessAria(page, '[data-chat-flow]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(join(DIR, 'ui.expected.md'), aria, MODE)
  })
})
