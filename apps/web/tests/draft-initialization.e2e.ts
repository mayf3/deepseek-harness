/** Unsubmitted drafts initialized through a real client plugin, persisted and restored by the shipped Web profile. */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Page } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { formatSessionReferenceMention } from '@deepseek-ai/dsh-session-reference'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { newEnglishPage } from './support.ts'

const FIXTURE = fileURLToPath(new URL('./fixtures/plugins/fixture-draft-initialization', import.meta.url))
const SCREENSHOTS = fileURLToPath(new URL('../../../.artifacts/screenshots', import.meta.url))
const FILE_NAME = 'notes 雪.md'
const FILE_BODY = '# Draft reference preview\n\nUnsubmitted file reference: 雪 🧭.\n'
const SETTLE = { timeout: 20_000 }

// This Host-plane spec cannot import the Client program's Cordis declarations.
interface DraftSnapshot {
  text: string
  references: {
    offset: number
    length: number
    source: 'reference'
    ref: string
    label: string
    appearance: 'file' | 'folder' | 'session'
    clipboardText: string
    invalid?: boolean
  }[]
}

const EMPTY: DraftSnapshot = { text: '', references: [] }

function composer(page: Page) {
  return page.locator('[data-composer-input][contenteditable="true"]').first()
}

function selectedSession(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const raw = localStorage.getItem('dsh.sessions.current')
    const value: unknown = raw === null ? null : JSON.parse(raw)
    return typeof value === 'object' && value !== null && 'sessionId' in value
      && typeof value.sessionId === 'string' ? value.sessionId : null
  })
}

function storedDraft(page: Page, sessionId: SessionId): Promise<unknown> {
  return page.evaluate((id) => {
    const raw = localStorage.getItem(`dsh.conversation.${id}`)
    const value: unknown = raw === null ? null : JSON.parse(raw)
    return typeof value === 'object' && value !== null && 'draft' in value ? value.draft : null
  }, sessionId)
}

async function assertDraft(page: Page, sessionId: SessionId, expected: DraftSnapshot): Promise<void> {
  await expect.poll(() => selectedSession(page), SETTLE).toBe(sessionId)
  await composer(page).waitFor()
  await expect.poll(() => storedDraft(page, sessionId), SETTLE).toEqual(expected)
  const chips = composer(page).locator('[data-composer-chip]')
  await expect.poll(() => chips.allTextContents(), SETTLE).toEqual(expected.references.map(reference => reference.label))
  expect(await chips.evaluateAll(elements => elements.map(element => ({
    source: element.getAttribute('data-composer-chip'), editable: element.getAttribute('contenteditable'),
  })))).toEqual(expected.references.map(() => ({ source: 'reference', editable: 'false' })))
  let displayed = expected.text
  for (const reference of [...expected.references].reverse()) {
    displayed = displayed.slice(0, reference.offset) + reference.label
      + displayed.slice(reference.offset + reference.length)
  }
  await expect.poll(() => composer(page).evaluate(element =>
    [...element.children].map(paragraph => paragraph.textContent).join('\n')), SETTLE).toBe(displayed)
}

async function initialize(page: Page, prompt: string | DraftSnapshot, workspaceId = '', clearPreviousDraft = false) {
  const panel = page.locator('[data-draft-initialization]')
  await panel.getByRole('textbox', { name: 'Target workspace ID', exact: true }).fill(workspaceId)
  await panel.getByRole('textbox', { name: 'Initial draft JSON', exact: true }).fill(JSON.stringify(prompt))
  await panel.getByRole('checkbox', { name: 'Clear previous draft', exact: true }).setChecked(clearPreviousDraft)
  await panel.getByRole('button', { name: 'Initialize draft', exact: true }).click()
}

async function openSession(page: Page, sessionId: SessionId) {
  const panel = page.locator('[data-draft-initialization]')
  await panel.getByRole('textbox', { name: 'Target session ID', exact: true }).fill(sessionId)
  await panel.getByRole('button', { name: 'Open session', exact: true }).click()
  await expect.poll(() => selectedSession(page), SETTLE).toBe(sessionId)
}

async function assertUnsubmitted(scaffold: WebScaffold, ids: readonly SessionId[]): Promise<void> {
  expect(ids.length).toBeGreaterThan(0)
  await scaffold.ctx.sessionPersistence.flush()
  for (const id of ids) {
    const handle = await scaffold.ctx.sessionPersistence.open(id, 'read')
    try {
      const { events } = await handle.read()
      expect(events.filter(event => event.type === 'user/message' || event.type === 'turn/start'), id).toEqual([])
    } finally {
      await handle.close()
    }
  }
}

async function launchDraftFixture() {
  const scaffold = await launchWebScaffold({ extraInstallAnchors: [join(FIXTURE, 'package.json')] })
  onTestFinished(() => scaffold.close())
  const first = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd, 'Draft origin')
  await scaffold.ctx.loader.create({ name: '@fixture/draft-initialization' })
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  const console = watchConsole(page)
  onTestFinished(async ({ task }) => {
    if (task.result?.state !== 'fail') return
    await mkdir(SCREENSHOTS, { recursive: true })
    const directory = await mkdtemp(join(SCREENSHOTS, 'draft-initialization-'))
    try {
      await page.screenshot({ path: join(directory, 'failure.png'), fullPage: true })
    } catch (error: unknown) {
      // A closed browser must not replace the test's original failure.
      globalThis.console.warn('Draft initialization failure screenshot unavailable:', error)
    }
  })
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await page.locator('[data-draft-initialization]').waitFor()
  await composer(page).waitFor()
  await expect.poll(() => first.sessionIds.length, SETTLE).toBe(1)
  const firstId = first.sessionIds[0]!
  await expect.poll(() => selectedSession(page), SETTLE).toBe(firstId)
  const secondPath = await mkdtemp(join(scaffold.workspaceCwd, 'draft-target-'))
  const second = await scaffold.ctx.workspaceRegistry.create(secondPath, 'Draft target')
  await page.getByText('Draft target', { exact: true }).first().waitFor()
  expect(second.sessionIds).toEqual([])
  return { scaffold, page, console, first, firstId, second }
}

function structuredDraft(sessionId: SessionId, title: string): DraftSnapshot {
  const file = `@"${FILE_NAME}"`
  const folder = '@"目录/"'
  const session = formatSessionReferenceMention({ sessionId, label: '关联会话 🧩' })
  const references: DraftSnapshot['references'] = []
  let text = `${title} 🧭 e\u0301 雪\n`
  for (let repeat = 0; repeat < 2; repeat++) {
    for (const item of [
      { ref: file, label: FILE_NAME, appearance: 'file' },
      { ref: folder, label: '目录/', appearance: 'folder' },
      { ref: session, label: '关联会话 🧩', appearance: 'session' },
    ] as const) {
      references.push({
        ...item, offset: text.length, length: item.ref.length,
        source: 'reference', clipboardText: item.ref,
      })
      text += `${item.ref} `
    }
    text += '\n'
  }
  // Equal mention text without a reference entry remains ordinary text.
  text += `普通文字 ${file}，末尾 🦉`
  return { text, references }
}

it('initializes a new blank Session, reuses its draft, replaces it explicitly and keeps a prompt-free clear empty', async () => {
  const { scaffold, page, console, firstId, second } = await launchDraftFixture()
  const initial = { text: '纯文字 🧭\n第二行 e\u0301', references: [] }
  await initialize(page, initial.text, second.id)
  await expect.poll(() => second.sessionIds.length, SETTLE).toBe(1)
  const secondId = second.sessionIds[0]!
  expect(secondId).not.toBe(firstId)
  await assertDraft(page, secondId, initial)

  await openSession(page, firstId)
  await initialize(page, '已有草稿不能被覆盖', second.id)
  await assertDraft(page, secondId, initial)
  expect(second.sessionIds).toEqual([secondId])
  const replacement = { text: '显式替换 🧪', references: [] }
  await initialize(page, replacement.text, '', true)
  await assertDraft(page, secondId, replacement)
  expect(second.sessionIds).toEqual([secondId])

  await page.getByRole('button', { name: 'Clear draft without prompt', exact: true }).click()
  await assertDraft(page, secondId, EMPTY)
  for (let round = 0; round < 2; round++) {
    await openSession(page, firstId)
    await openSession(page, secondId)
    await assertDraft(page, secondId, EMPTY)
  }
  await page.reload({ waitUntil: 'load' })
  await assertDraft(page, secondId, EMPTY)
  await assertUnsubmitted(scaffold, [firstId, secondId])
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})

it('restores repeated file, folder and Session capsules across edits, Workspace switches and reload without submitting', async () => {
  const { scaffold, page, console, first, firstId, second } = await launchDraftFixture()
  for (const workspace of [first, second]) {
    await mkdir(join(workspace.path, '目录'))
    await writeFile(join(workspace.path, FILE_NAME), FILE_BODY)
  }
  const secondDraft = structuredDraft(firstId, '工作区乙')
  await initialize(page, secondDraft, second.id)
  await expect.poll(() => second.sessionIds.length, SETTLE).toBe(1)
  const secondId = second.sessionIds[0]!
  await assertDraft(page, secondId, secondDraft)
  expect(await composer(page).evaluate(element => ({
    paragraphs: [...element.children].map(paragraph => paragraph.textContent),
    capsules: [...element.querySelectorAll('[data-composer-chip]')].map(chip => ({
      source: chip.getAttribute('data-composer-chip'),
      editable: chip.getAttribute('contenteditable'),
      label: chip.textContent,
    })),
  }))).toMatchInlineSnapshot(`
    {
      "capsules": [
        {
          "editable": "false",
          "label": "notes 雪.md",
          "source": "reference",
        },
        {
          "editable": "false",
          "label": "目录/",
          "source": "reference",
        },
        {
          "editable": "false",
          "label": "关联会话 🧩",
          "source": "reference",
        },
        {
          "editable": "false",
          "label": "notes 雪.md",
          "source": "reference",
        },
        {
          "editable": "false",
          "label": "目录/",
          "source": "reference",
        },
        {
          "editable": "false",
          "label": "关联会话 🧩",
          "source": "reference",
        },
      ],
      "paragraphs": [
        "工作区乙 🧭 é 雪",
        "notes 雪.md 目录/ 关联会话 🧩 ",
        "notes 雪.md 目录/ 关联会话 🧩 ",
        "普通文字 @\"notes 雪.md\"，末尾 🦉",
      ],
    }
  `)
  const firstDraft = structuredDraft(secondId, '工作区甲')
  await initialize(page, firstDraft, first.id)
  await assertDraft(page, firstId, firstDraft)

  const drafts = [{ id: firstId, draft: firstDraft }, { id: secondId, draft: secondDraft }]
  for (let round = 0; round < 3; round++) {
    for (const item of drafts) {
      await openSession(page, item.id)
      await assertDraft(page, item.id, item.draft)
      await composer(page).click()
      await page.keyboard.press('ControlOrMeta+End')
      const suffix = ` · 编辑${round} 🧪`
      await page.keyboard.insertText(suffix)
      item.draft = { ...item.draft, text: item.draft.text + suffix }
      await assertDraft(page, item.id, item.draft)
    }
  }
  await page.reload({ waitUntil: 'load' })
  await assertDraft(page, secondId, drafts[1]!.draft)
  await page.locator('[data-draft-initialization]').waitFor()
  for (const item of drafts) {
    await openSession(page, item.id)
    await assertDraft(page, item.id, item.draft)
  }
  await composer(page).locator('[data-composer-chip]').first().click()
  await expect.poll(() => page.locator('[data-document-markdown]').textContent(), SETTLE)
    .toContain('Unsubmitted file reference: 雪 🧭.')
  await assertDraft(page, secondId, drafts[1]!.draft)
  await page.getByRole('button', { name: 'Clear draft without prompt', exact: true }).click()
  await assertDraft(page, secondId, EMPTY)
  for (let round = 0; round < 2; round++) {
    await openSession(page, firstId)
    await assertDraft(page, firstId, drafts[0]!.draft)
    await openSession(page, secondId)
    await assertDraft(page, secondId, EMPTY)
  }
  await page.reload({ waitUntil: 'load' })
  await assertDraft(page, secondId, EMPTY)
  expect(first.sessionIds).toEqual([firstId])
  expect(second.sessionIds).toEqual([secondId])
  await assertUnsubmitted(scaffold, [firstId, secondId])
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})

it('reads a legacy string from the existing conversation key and saves ordinary edits as a structured draft', async () => {
  const { scaffold, page, console, firstId } = await launchDraftFixture()
  const legacy = '旧字符串草稿 🧭\n普通 @notes，不是胶囊'
  // Seed the old storage representation before the reloaded client creates its stores.
  await page.addInitScript(({ id, text }) => {
    localStorage.setItem(`dsh.conversation.${id}`, JSON.stringify({ draft: text, view: null, viewRequest: null }))
  }, { id: firstId, text: legacy })
  await page.reload({ waitUntil: 'load' })
  await expect.poll(() => selectedSession(page), SETTLE).toBe(firstId)
  await composer(page).waitFor()
  await expect.poll(() => composer(page).evaluate(element =>
    [...element.children].map(paragraph => paragraph.textContent).join('\n')), SETTLE).toBe(legacy)
  expect(await composer(page).locator('[data-composer-chip]').count()).toBe(0)
  await composer(page).click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.insertText('，继续编辑')
  await assertDraft(page, firstId, { text: `${legacy}，继续编辑`, references: [] })
  await assertUnsubmitted(scaffold, [firstId])
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})
