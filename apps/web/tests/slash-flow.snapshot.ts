// @vitest-environment jsdom
// Assembled keyless snapshot of the slash/input/session convergence under the
// agent-parity model: the New Session view state locks the composer until a
// Workspace is picked (connectWorkspace materializes the full Session+Agent),
// the '@' menu descends a Host-backed file directory, the '/' menu serves the
// session's wire command catalog (sessions are always agent-backed — no
// draft/materialized split), a leadingInput command claims, submits over the
// wire, and notices its result, and the SAME composer textarea then carries
// the first plain send, whose ACCEPTANCE (not attempt) flips blank and
// surfaces the session in lists. This is the user-visible acceptance anchor —
// package mocks do not substitute for the assembled application transcript.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { WebBootEntry } from '@deepseek-ai/dsh-client-modules/client'
import { AppWebEntry } from '@deepseek-ai/dsh-client-web'

const PLUGINS: readonly (WebBootEntry & { dir: string })[] = [
  { id: '@deepseek-ai/dsh-client-connection', dir: 'connection', url: '/plugins/connection.js', rev: 'fx', inject: [], immediately: true },
  { id: '@deepseek-ai/dsh-client-runtime', dir: 'runtime', url: '/plugins/runtime.js', rev: 'fx', inject: ['@deepseek-ai/dsh-client-connection'], immediately: true },
  { id: '@deepseek-ai/dsh-client-ui-theme', dir: 'ui-theme', url: '/plugins/ui-theme.js', rev: 'fx', inject: [], immediately: true },
  { id: '@deepseek-ai/dsh-client-locale', dir: 'locale', url: '/plugins/locale.js', rev: 'fx', inject: [], immediately: true },
  { id: '@deepseek-ai/dsh-client-ui-layout', dir: 'ui-layout', url: '/plugins/ui-layout.js', rev: 'fx', inject: ['@deepseek-ai/dsh-client-runtime'] },
  { id: '@deepseek-ai/dsh-client-ui-sidebar', dir: 'ui-sidebar', url: '/plugins/ui-sidebar.js', rev: 'fx', inject: ['@deepseek-ai/dsh-client-ui-layout'] },
  { id: '@deepseek-ai/dsh-client-ui-slash', dir: 'ui-slash', url: '/plugins/ui-slash.js', rev: 'fx', inject: ['@deepseek-ai/dsh-client-runtime'] },
  { id: '@deepseek-ai/dsh-client-ui-conversation', dir: 'ui-conversation', url: '/plugins/ui-conversation.js', rev: 'fx', inject: ['@deepseek-ai/dsh-client-ui-layout', '@deepseek-ai/dsh-client-ui-slash'] },
  { id: '@deepseek-ai/dsh-client-ui-command', dir: 'ui-command', url: '/plugins/ui-command.js', rev: 'fx', inject: ['@deepseek-ai/dsh-client-ui-slash', '@deepseek-ai/dsh-client-ui-conversation'] },
  { id: '@deepseek-ai/dsh-client-ui-skill', dir: 'ui-skill', url: '/plugins/ui-skill.js', rev: 'fx', inject: ['@deepseek-ai/dsh-client-ui-slash'] },
  { id: '@deepseek-ai/dsh-client-ui-reference', dir: 'ui-reference', url: '/plugins/ui-reference.js', rev: 'fx', inject: ['@deepseek-ai/dsh-client-connection', '@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-ui-slash'] },
  {
    id: '@deepseek-ai/dsh-client-ui-workspace',
    dir: 'ui-workspace',
    url: '/plugins/ui-workspace.js',
    rev: 'fx',
    inject: [
      '@deepseek-ai/dsh-client-runtime',
      '@deepseek-ai/dsh-client-ui-conversation',
      '@deepseek-ai/dsh-client-ui-sidebar',
    ],
  },
]

const bundles = new Map(PLUGINS.map(plugin => [
  plugin.url,
  readFileSync(join(process.cwd(), 'packages/client', plugin.dir, 'lib/client.js'), 'utf8'),
]))

interface FixtureWindow extends Window {
  __DSH_BOOT__?: { rev: string; entries: WebBootEntry[] }
  __ModuleLoader__?: unknown
}

class ResizeObserverStub {
  observe(): void {}
  disconnect(): void {}
  unobserve(): void {}
}

const win = window as FixtureWindow
let unmount: (() => void) | undefined

beforeEach(() => {
  localStorage.clear()
  document.title = 'DeepSeek Harness'
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    setTimeout(() => { callback(0) }, 0) as unknown as number)
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { clearTimeout(id) })
})

afterEach(() => {
  act(() => { unmount?.() })
  unmount = undefined
  cleanup()
  delete win.__DSH_BOOT__
  delete win.__ModuleLoader__
  delete (globalThis as Record<string, unknown>).__fxTiming
  document.body.innerHTML = ''
  document.head.querySelectorAll('style[data-plugin]').forEach((style) => { style.remove() })
  document.title = ''
  history.replaceState(null, '', '/')
  vi.unstubAllGlobals()
})

/** Boot the complete built client graph against one keyless fixture branch. */
function boot(search: string): void {
  history.replaceState(null, '', `/${search}`)
  const root = document.createElement('div')
  root.id = 'root'
  document.body.appendChild(root)
  win.__DSH_BOOT__ = { rev: 'fx', entries: PLUGINS.map(({ dir: _dir, ...plugin }) => plugin) }
  act(() => {
    const entry = new AppWebEntry(root, {
      fetchBundle: (url) => {
        const code = bundles.get(url)
        return code === undefined ? Promise.reject(new Error(`missing built bundle ${url}`)) : Promise.resolve(code)
      },
      executeBundle: (code) => { (0, eval)(code) },
    })
    void entry.run()
    unmount = () => { entry.dispose() }
  })
}

/** Collapse decorative whitespace while preserving the text a user sees. */
function visibleText(element: Element): string {
  return (element.textContent ?? '').replace(/\s+/g, ' ').trim()
}

/** Type into the machine-driven composer and let the change echo back. */
async function typeComposer(composer: HTMLTextAreaElement, value: string): Promise<void> {
  fireEvent.change(composer, { target: { value } })
  await waitFor(() => { expect(composer.value).toBe(value) })
}

it('locked view state, connectWorkspace unlock, @file and /echo chains, and blank-on-acceptance ride one resident composer', async () => {
  boot('?fixture=empty')

  // View state: no session entity — the composer renders locked; only the
  // workspace picker is live.
  const locked = await screen.findByPlaceholderText<HTMLTextAreaElement>(
    'Choose a workspace to start', {}, { timeout: 10_000 },
  )
  expect(locked.disabled).toBe(true)

  // Pick (create) a Workspace: connectWorkspace materializes the full
  // Session+Agent and the provider swaps in the live blank-session hero.
  fireEvent.click(screen.getAllByRole('button', { name: 'Choose workspace' })
    .find(el => el.getAttribute('aria-haspopup') === 'menu')!)
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Create workspace' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Create a new workspace' }))
  const dialog = await screen.findByRole('dialog', { name: 'Create a new workspace' })
  fireEvent.change(within(dialog).getByRole('textbox', { name: 'New workspace name' }), {
    target: { value: 'nova' },
  })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Create workspace' }))

  const composer = await screen.findByPlaceholderText<HTMLTextAreaElement>(
    'Describe what you want to build', {}, { timeout: 10_000 },
  )
  expect(composer.disabled).toBe(false)

  // '@' combines Host-backed references. Picking a directory keeps
  // completion open at its trailing slash; picking a file closes it with a
  // separator so ordinary prompt text can continue.
  await typeComposer(composer, '@')
  const referenceMenu = await screen.findByRole('listbox', { name: 'Trigger suggestions' })
  await waitFor(() => { expect(visibleText(referenceMenu)).toContain('Folder · notes/') })
  const referenceSections = [
    within(referenceMenu).getByText('文件与文件夹').textContent,
  ]
  fireEvent.mouseDown(screen.getByRole('option', { name: /Folder · notes\// }))
  await waitFor(() => { expect(composer.value).toBe('@notes/') })
  const nestedFile = await screen.findByRole('option', { name: /File · demo\.txt/ })
  fireEvent.mouseDown(nestedFile)
  await waitFor(() => { expect(composer.value).toBe('@notes/demo.txt ') })
  const filePathCompleted = composer.value
  await typeComposer(composer, '')

  // '/' opens the menu with the session's wire command catalog (the session
  // is agent-backed from birth — the catalog is the single-address list).
  await typeComposer(composer, '/')
  const menu = await screen.findByRole('listbox', { name: 'Trigger suggestions' })
  await waitFor(() => { expect(visibleText(menu)).toContain('echo') })
  const menuText = visibleText(menu)

  // Pick /echo (leadingInput): the claim token lands in the same textarea.
  fireEvent.mouseDown(screen.getByRole('option', { name: /echo/ }))
  await waitFor(() => { expect(composer.value).toBe('/echo ') })

  // Type args and submit: the claim executes over the wire and notices its
  // result; the token is consumed and the draft returns to plain text.
  await typeComposer(composer, '/echo hello parser')
  fireEvent.keyDown(composer, { key: 'Enter' })
  await screen.findByText('hello parser', {}, { timeout: 10_000 })
  await waitFor(() => { expect(composer.value).toBe('') })

  // Slash execution does not flip blank: the selected row remains New Session.
  const tree = screen.getByRole('tree', { name: 'Sessions' })
  expect(within(tree).getByText('1 session')).toBeDefined()
  expect(within(tree).getByText('New Session')).toBeDefined()

  // First plain send through the SAME textarea: acceptance logs the user
  // message and converts the existing sidebar row out of blank.
  const before = composer
  await typeComposer(composer, 'build me a parser')
  fireEvent.keyDown(composer, { key: 'Enter' })
  await waitFor(() => {
    expect(screen.queryByText("Let's start building")).toBeNull()
  }, { timeout: 10_000 })
  await waitFor(() => { expect(within(tree).getByText('1 session')).toBeDefined() }, { timeout: 10_000 })
  const after = document.querySelector('textarea')

  expect({
    menuHadEcho: menuText.includes('echo'),
    menuHadCompact: menuText.includes('compact'),
    referenceSections,
    filePathCompleted,
    composerSurvivedConversion: after === before,
    sessionListed: visibleText(within(tree).getByText('1 session').closest('[role="treeitem"]')!),
  }).toMatchInlineSnapshot(`
    {
      "composerSurvivedConversion": true,
      "filePathCompleted": "@notes/demo.txt ",
      "menuHadCompact": true,
      "menuHadEcho": true,
      "referenceSections": [
        "文件与文件夹",
      ],
      "sessionListed": "nova1 session",
    }
  `)
})

it('the assembled @ menu inserts a session candidate as one atomic chip', async () => {
  boot('?fixture')
  const composer = await screen.findByPlaceholderText<HTMLTextAreaElement>(
    'Describe what you want to build', {}, { timeout: 10_000 },
  )
  await typeComposer(composer, '@')
  const menu = await screen.findByRole('listbox', { name: 'Trigger suggestions' })
  await waitFor(() => {
    expect(visibleText(menu)).toContain('Session · Fixture child session')
  })
  const referenceSections = [
    within(menu).getByText('文件与文件夹').textContent,
    within(menu).getByText('Session 对话').textContent,
  ]
  fireEvent.mouseDown(screen.getByRole('option', { name: /Session · Fixture child session/ }))
  await waitFor(() => {
    expect(composer.value).toBe('\uFFFC')
  })
  const chip = document.querySelector<HTMLElement>('[data-decoration="chip"]')
  expect({
    atomicDraftLength: composer.value.length,
    chipLabel: chip?.title,
    menuClosed: screen.queryByRole('listbox', { name: 'Trigger suggestions' }) === null,
    referenceSections,
  }).toMatchInlineSnapshot(`
    {
      "atomicDraftLength": 1,
      "chipLabel": "@Fixture child session",
      "menuClosed": true,
      "referenceSections": [
        "文件与文件夹",
        "Session 对话",
      ],
    }
  `)
})
