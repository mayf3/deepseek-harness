import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { DesktopBackgroundNotice } from '../src/background-notice.ts'
import { resolveDesktopLocale } from '../src/locale.ts'

const native = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events')
  const notices: Notice[] = []
  class Notice extends EventEmitter {
    static isSupported = vi.fn(() => true)
    show = vi.fn()
    constructor(readonly options: unknown) { super(); notices.push(this) }
  }
  return { notices, Notice }
})
vi.mock('electron', () => ({ Notification: native.Notice }))

const roots: string[] = []
afterEach(() => {
  native.notices.length = 0
  vi.clearAllMocks()
  vi.restoreAllMocks()
  native.Notice.isSupported.mockReturnValue(true)
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function setup(markerPath = join(mkdtempSync(join(tmpdir(), 'dsh-desktop-notice-')), 'state', 'background-notice-shown')) {
  roots.push(join(markerPath, '..', '..'))
  const open = vi.fn()
  const notice = new DesktopBackgroundNotice({ markerPath, locale: () => resolveDesktopLocale('zh'), open })
  return { notice, open, markerPath }
}

it('notifies once per installation, records the marker, and opens the window on click', () => {
  const f = setup()
  f.notice.show()
  f.notice.show()
  expect(existsSync(f.markerPath)).toBe(true)
  expect(native.notices).toHaveLength(1)
  expect(native.notices[0]!.options).toEqual({
    title: 'DeepSeek Harness 仍在后台运行', body: '正在运行的任务不会中断。可在系统托盘中重新打开或退出。', silent: true,
  })
  expect(native.notices[0]!.show).toHaveBeenCalledOnce()
  native.notices[0]!.emit('click')
  native.notices[0]!.emit('click')
  expect(f.open).toHaveBeenCalledOnce()
  // The next process of the same installation finds the marker.
  const again = new DesktopBackgroundNotice({ markerPath: f.markerPath, locale: () => resolveDesktopLocale('zh'), open: f.open })
  again.show()
  expect(native.notices).toHaveLength(1)
})

it('still notifies once in this process when the marker cannot be written', () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-notice-'))
  roots.push(root)
  // A file where the marker's directory should be makes the marker write fail.
  writeFileSync(join(root, 'blocker'), '')
  const open = vi.fn()
  const blocked = new DesktopBackgroundNotice({ markerPath: join(root, 'blocker', 'background-notice-shown'), locale: () => resolveDesktopLocale('zh'), open })
  blocked.show()
  blocked.show()
  expect(console.warn).toHaveBeenCalledWith('desktop tray: could not record the background notice', expect.anything())
  expect(native.notices).toHaveLength(1)
})

it('keeps the notice for a later launch when notifications are unsupported or delivery fails', () => {
  native.Notice.isSupported.mockReturnValue(false)
  const f = setup()
  f.notice.show()
  f.notice.show()
  expect(native.notices).toHaveLength(0)
  expect(existsSync(f.markerPath)).toBe(false)
  native.Notice.isSupported.mockReturnValue(true)
  const g = setup()
  g.notice.show()
  expect(existsSync(g.markerPath)).toBe(true)
  native.notices[0]!.emit('failed')
  expect(existsSync(g.markerPath)).toBe(false)
  native.notices[0]!.emit('click')
  expect(g.open).not.toHaveBeenCalled()
  // One attempt per process even after the marker was withdrawn.
  g.notice.show()
  expect(native.notices).toHaveLength(1)
})

it('does not record a notice the system refused to construct', () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const f = setup()
  native.Notice.isSupported.mockImplementation(() => { throw new Error('toast host unavailable') })
  f.notice.show()
  expect(native.notices).toHaveLength(0)
  expect(existsSync(f.markerPath)).toBe(false)
  expect(console.warn).toHaveBeenCalledWith('desktop tray: background notice unavailable', expect.any(Error))
})
