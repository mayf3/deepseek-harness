// @vitest-environment jsdom
/**
 * The session-rename assembly chain on SlotTestRuntime (real apply, real
 * WorkspaceBrowser occupying the sidebar hole): row menu → rename dialog →
 * the injected renameSession hop (sessions.binding → ISession.rename) → on
 * the accepted unary response the dialog closes and the row re-labels from
 * the list state — no push-frame wait. Coverage split: the assembled-app
 * snapshot (apps/web/tests/session-actions.snapshot.ts) pins the full-app
 * transcript; the
 * verb's wire behavior stays with the Session Controller client package
 * (session.spec.ts#rename), the dialog's own arms with rows.spec /
 * workspace-browser.spec.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import type { ISession } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { SessionSeq, type SessionId } from '@deepseek-ai/dsh-session/types'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { RemoteError, SlotTestRuntime, usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { MenuAction } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  apply, inject, type SessionMenuActionOwnerProps,
} from '@deepseek-ai/dsh-client-ui-workspace/client'

// The service reads its initial locale from the browser; these specs assert
// the shipped Chinese copy, so they state the browser they assume.
usePinnedBrowserLanguages('zh-CN')

const SID = 's1' as SessionId

afterEach(cleanup)
beforeEach(() => { localStorage.clear() })

/** Runtime with the locale face installed (the browser entry declares `locale:` — zh default backs the t seat). */
async function createRuntime(): Promise<SlotTestRuntime> {
  const runtime = await SlotTestRuntime.create()
  runtime.ctx.provide('layout', { selectPanel: vi.fn() })
  runtime.releaseWorkspaceSource()
  // The rename flow never picks a directory; the namespace only has to be there
  // for ui-workspace's inject to settle.
  const directoryPicker = {}
  runtime.remote.provideNamespaces({ directoryPicker })
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  return runtime
}

/** Test-owned sidebar shell role: declares and renders the browsing region. */
type FrameProps = PropsRenderSlots<'sidebar.workspaces'>
function SidebarFrame({ renderSlot }: FrameProps) {
  return <>{renderSlot('sidebar.workspaces', { wide: true, expandSidebar: () => {} })}</>
}

describe('session rename through the assembled browser', () => {
  it('renders independently registered Session actions in declared order', async () => {
    const runtime = await createRuntime()
    const selected = vi.fn()
    await runtime.sessions.add({
      id: SID,
      summary: { title: 'Persisted title', displayTitle: 'Session title', cwd: '/w/alpha' },
      session: { rename: vi.fn() },
    })
    await runtime.sessions.retainFor(runtime.ctx, SID, { source: 'mainView' }).ready
    await runtime.workspaces.update((draft) => {
      draft.items = [{
        workspaceId: 'w1' as WorkspaceId, title: 'alpha', path: '/w/alpha',
        sessionIds: [SID], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      }] as never
    })
    await runtime.root.declare(
      { 'sidebar.workspaces': { kind: 'single', scope: 'root' } } as never,
      SidebarFrame as never,
    )
    await runtime.mount({ inject: [...inject], apply })
    const registerAction = (id: string, order: number, label: string, dynamic = false) => {
      runtime.slots.register(
        { name: 'sidebar.workspaces.session.menu.action', id, order },
        ({ sessionId, displayTitle, dismiss }: SessionMenuActionOwnerProps) => dynamic
          ? (
            <button type="button" role="menuitem" onClick={() => {
              selected(id, sessionId, displayTitle)
              dismiss()
            }}>{label}</button>
          )
          : (
            <MenuAction onSelect={() => { selected(id, sessionId, displayTitle) }}>{label}</MenuAction>
          ),
      )
    }
    registerAction('later', 20, 'Later action')
    registerAction('earlier', 10, 'Earlier action', true)
    const view = runtime.renderRoot()

    const row = (await view.findByText('Session title')).closest('[role="treeitem"]')!
    fireEvent.click(within(row as HTMLElement).getByLabelText('会话“Session title”的操作'))
    expect(view.getAllByRole('menuitem').map(item => item.textContent)).toEqual([
      '重命名', '分叉会话', '归档会话', 'Earlier action', 'Later action',
    ])
    fireEvent.click(view.getByRole('menuitem', { name: 'Earlier action' }))
    expect(selected).toHaveBeenCalledWith('earlier', SID, 'Session title')
    expect(view.queryByRole('menu')).toBeNull()
    await act(async () => { await Promise.resolve() })
    expect(document.activeElement).toBe(within(row as HTMLElement).getByLabelText('会话“Session title”的操作'))
    await runtime.dispose()
  })

  it('renames via the row menu: binding.session.rename fires, the dialog closes, the row re-labels from the list', async () => {
    const runtime = await createRuntime()
    const rename = vi.fn<ISession['rename']>(async title => ({
      ok: true, value: { title: title.trim().replace(/\s+/g, ' '), seq: SessionSeq(7) },
    }))
    await runtime.sessions.add({
      id: SID,
      summary: { title: '旧标题', displayTitle: '旧标题', cwd: '/w/alpha' },
      session: { rename },
    })
    await runtime.sessions.retainFor(runtime.ctx, SID, { source: 'mainView' }).ready
    await runtime.workspaces.update((draft) => {
      draft.items = [{
        workspaceId: 'w1' as WorkspaceId, title: 'alpha', path: '/w/alpha',
        sessionIds: [SID], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      }] as never
    })
    await runtime.root.declare(
      { 'sidebar.workspaces': { kind: 'single', scope: 'root' } } as never,
      SidebarFrame as never,
    )
    await runtime.mount({ inject: [...inject], apply })
    const view = runtime.renderRoot()

    // The current session's group auto-expands; open the row's action menu.
    const row = (await view.findByText('旧标题')).closest('[role="treeitem"]')!
    fireEvent.click(within(row as HTMLElement).getByLabelText('会话“旧标题”的操作'))
    fireEvent.click(view.getByRole('menuitem', { name: '重命名', hidden: true }))

    // The dialog seeds from the current title; submit a padded value.
    const input = await view.findByLabelText('会话名称') as HTMLInputElement
    expect(input.value).toBe('旧标题')
    fireEvent.change(input, { target: { value: '  分叉  实验记录  ' } })
    fireEvent.click(view.getByRole('button', { name: '重命名' }))

    // The injected hop reached the session face with the edge-trimmed draft
    // (the dialog trims edges; interior normalization is host-side).
    await waitFor(() => { expect(rename).toHaveBeenCalledWith('分叉  实验记录') })
    // Acceptance closes the dialog without any push-frame wait.
    await waitFor(() => { expect(view.queryByLabelText('会话名称')).toBeNull() })
    // The manager lands the unary echo in the list store (its own package
    // tests own that hop); the row re-labels from list state alone.
    await runtime.sessions.updateSummary(SID, { displayTitle: '分叉 实验记录', title: '分叉 实验记录' })
    await view.findByText('分叉 实验记录')
    expect(view.queryByText('旧标题')).toBeNull()
    await runtime.dispose()
  })

  it('a rejected rename keeps the dialog open with the error surfaced', async () => {
    const runtime = await createRuntime()
    const rename = vi.fn<ISession['rename']>(async () => ({
      ok: false, error: new RemoteError('gateway/internal', 'title write failed', {}),
    }))
    await runtime.sessions.add({
      id: SID,
      summary: { title: '旧标题', displayTitle: '旧标题', cwd: '/w/alpha' },
      session: { rename },
    })
    await runtime.sessions.retainFor(runtime.ctx, SID, { source: 'mainView' }).ready
    await runtime.workspaces.update((draft) => {
      draft.items = [{
        workspaceId: 'w1' as WorkspaceId, title: 'alpha', path: '/w/alpha',
        sessionIds: [SID], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      }] as never
    })
    await runtime.root.declare(
      { 'sidebar.workspaces': { kind: 'single', scope: 'root' } } as never,
      SidebarFrame as never,
    )
    await runtime.mount({ inject: [...inject], apply })
    const view = runtime.renderRoot()
    await runtime.flush()

    const row = (await view.findByText('旧标题')).closest('[role="treeitem"]')!
    fireEvent.click(within(row as HTMLElement).getByLabelText('会话“旧标题”的操作'))
    fireEvent.click(view.getByRole('menuitem', { name: '重命名', hidden: true }))
    const input = await view.findByLabelText('会话名称')
    fireEvent.change(input, { target: { value: '新名' } })
    fireEvent.click(view.getByRole('button', { name: '重命名' }))

    // Failure: the injected hop rethrows the business error; the dialog
    // stays open with the alert and the row keeps its title.
    const alert = await view.findByRole('alert')
    expect(alert.textContent).toContain('title write failed')
    expect(view.getByLabelText('会话名称')).toBeTruthy()
    expect(view.getByText('旧标题')).toBeTruthy()
    await runtime.dispose()
  })
})
