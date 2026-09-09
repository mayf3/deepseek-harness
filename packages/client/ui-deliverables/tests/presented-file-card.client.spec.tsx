// @vitest-environment jsdom
/** Explicit file actions preserve their destination, availability, and independent failure state. */
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { PresentedFileCard } from '../src/client/PresentedFileCard.tsx'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)
const props = () => ({
  cwd: undefined,
  file: { path: 'out/report.pdf', description: 'Final report', seq: 4, index: 1 },
  host: { name: 'remote-desktop', available: true, fileManager: 'finder' as const },
  phase: undefined,
  onAction: vi.fn(),
  t: makeTranslate(en),
})

it.each([
  ['finder', 'Show in Finder'], ['explorer', 'Show in File Explorer'], ['directory', 'Open containing folder'],
] as const)('uses the Host %s action and closes the menu after selection', (fileManager, label) => {
  const p = props()
  const view = render(<PresentedFileCard {...p} host={{ ...p.host, fileManager }} />)
  fireEvent.click(view.getByRole('button', { name: 'More file actions for out/report.pdf' }))
  expect(view.getByText('Opens on remote-desktop')).toBeTruthy()
  fireEvent.click(view.getByRole('menuitem', { name: new RegExp(label) }))
  expect(p.onAction).toHaveBeenCalledWith('reveal')
  expect(view.queryByRole('menu')).toBeNull()
  fireEvent.click(view.getByRole('button', { name: 'Open out/report.pdf in default app' }))
  expect(p.onAction).toHaveBeenLastCalledWith('open')
  fireEvent.click(view.getByRole('button', { name: 'More file actions for out/report.pdf' }))
  fireEvent.click(view.getByRole('menuitem', { name: /Open in default app/ }))
  expect(p.onAction).toHaveBeenCalledTimes(3)
})

it('dismisses the menu with Escape or an outside click without launching anything', () => {
  const p = props()
  const view = render(<PresentedFileCard {...p} />)
  const trigger = view.getByRole('button', { name: 'More file actions for out/report.pdf' })
  fireEvent.click(trigger)
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(view.queryByRole('menu')).toBeNull()
  fireEvent.click(trigger)
  fireEvent.pointerDown(document.body)
  expect(view.queryByRole('menu')).toBeNull()
  expect(p.onAction).not.toHaveBeenCalled()
})

it.each(['opening', 'revealing'] as const)('disables both gestures while %s', (phase) => {
  const p = props()
  const view = render(<PresentedFileCard {...p} phase={phase} />)
  for (const button of view.getAllByRole('button')) {
    expect((button as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(button)
  }
  expect(p.onAction).not.toHaveBeenCalled()
})

it('keeps actions disabled until a desktop is available', () => {
  const p = props()
  const view = render(<PresentedFileCard {...p} host={null} />)
  expect(view.getAllByRole('button').every(button => (button as HTMLButtonElement).disabled)).toBe(true)
  view.rerender(<PresentedFileCard {...p} host={{ ...p.host, available: false, fileManager: null }} />)
  expect(view.getAllByRole('button').every(button => (button as HTMLButtonElement).disabled)).toBe(true)
})

it('localizes reveal failures and accurately reports a directory-only action', () => {
  const p = props()
  const view = render(<PresentedFileCard {...p} phase="revealError" t={makeTranslate(zh)} />)
  expect(view.getByRole('status').textContent).toBe(zh['presented.revealError'])
  view.rerender(<PresentedFileCard {...p} phase="revealed" host={{ ...p.host, fileManager: 'directory' }} />)
  expect(view.getByRole('status').textContent).toBe(en['presented.directoryOpened'])
  view.rerender(<PresentedFileCard {...p} phase="revealed" />)
  expect(view.getByRole('status').textContent).toBe(en['presented.revealed'])
})


it('supports keyboard selection and returns focus to the trigger on Escape', () => {
  const view = render(<PresentedFileCard {...props()} />)
  const trigger = view.getByRole('button', { name: 'More file actions for out/report.pdf' })
  fireEvent.click(trigger)
  const items = view.getAllByRole('menuitem')
  expect(document.activeElement).toBe(items[0])
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
  expect(document.activeElement).toBe(items[1])
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
  expect(document.activeElement).toBe(items[0])
  fireEvent.keyDown(document.activeElement!, { key: 'End' })
  expect(document.activeElement).toBe(items[1])
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' })
  expect(document.activeElement).toBe(items[0])
  fireEvent.keyDown(document.activeElement!, { key: 'Home' })
  expect(document.activeElement).toBe(items[0])
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
  expect(document.activeElement).toBe(trigger)
})


it('shortens the workspace prefix while retaining the full location on hover and in action labels', () => {
  const p = props()
  const path = '/work/reports/result.pdf'
  const view = render(<PresentedFileCard {...p} cwd="/work" file={{ ...p.file, path }} />)
  expect(view.getByTitle(path).textContent).toBe('reports/result.pdf')
  fireEvent.click(view.getByRole('button', { name: `Open ${path} in default app` }))
  expect(p.onAction).toHaveBeenCalledWith('open')
  view.rerender(<PresentedFileCard {...p} cwd="/work" />)
  expect(view.getByTitle('/work/out/report.pdf').textContent).toBe('out/report.pdf')
})
