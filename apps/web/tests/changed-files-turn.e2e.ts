/** A turn that edits, creates, and shell-appends files in a git workspace ends with the changed-files card; its rows open comparisons. */
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
    await card.waitFor({ state: 'visible' })
    expect(await card.getByText('已编辑 4 个文件', { exact: true }).count()).toBe(1)
    expect(await card.getByRole('listitem').count()).toBe(3)
    expect(await card.getByRole('button', { name: '展开全部 4 个改动文件' }).count()).toBe(1)
    // Without a Host desktop the header is a label; every row opens its comparison in the Sidebar.
    expect(await card.getByRole('button', { name: '打开改动文件所在的文件夹' }).count()).toBe(0)
    expect(await card.getByRole('button', { name: '查看 notes.txt 的改动' }).count()).toBe(1)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })

  it('opens a shell-appended file’s comparison from the snapshots and an ignored file’s from its captured copies', async () => {
    const card = page.locator('[data-changed-files]')
    const column = page.locator('[data-rightbar-col]')
    await card.getByRole('button', { name: '查看 notes.txt 的改动' }).click()
    const notes = column.locator('[data-changes-diff][data-diff-state="text"]')
    await notes.waitFor({ state: 'visible' })
    expect(await column.locator('[data-dockkit-tab]').filter({ hasText: 'notes.txt' }).count()).toBe(1)
    expect(await notes.locator('[data-diff-line]').evaluateAll(lines => lines.map(line => `${line.getAttribute('data-diff-line')}:${line.textContent}`))).toEqual([
      'context:11 start', 'add:2+done',
    ])
    // The ignored file has no snapshot; its comparison comes from the copies captured around the write call.
    await card.getByRole('button', { name: '查看 app.local 的改动' }).click()
    const local = column.locator('[data-changes-diff][data-diff-state="text"]').filter({ hasText: 'mode=demo' })
    await local.waitFor({ state: 'visible' })
    expect(await local.locator('[data-diff-line]').evaluateAll(lines => lines.map(line => `${line.getAttribute('data-diff-line')}:${line.textContent}`))).toEqual(['add:1+mode=demo'])
    expect(await local.getByText('本轮新建的文件').count()).toBe(1)
    // No desktop, so the header offers no native open.
    expect(await local.getByRole('button').count()).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })

  it.skipIf(MODE === 'record')('replays the workspace and the Chinese conversation', async () => {
    await assertFinalWorkspaceSnapshot(DIR, cwd, { ignoredRootEntries: ['.git'] })
    const aria = await captureExpandedTurnProcessAria(page, '[data-chat-flow]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(join(DIR, 'ui.expected.md'), aria, MODE)
  })
})
