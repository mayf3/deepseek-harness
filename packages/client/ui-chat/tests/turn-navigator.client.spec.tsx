// @vitest-environment jsdom

import { createRef, StrictMode } from 'react'
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { TurnNavigator, type TurnNavigatorHandle } from '../src/client/chat/TurnNavigator.tsx'
import type { TurnRailItem } from '../src/client/chat/turn-rail-items.ts'
import { zh } from '../src/client/locale.ts'
import { installTurnNavigatorObserver } from './turn-navigator-fixture.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const items: readonly TurnRailItem[] = Array.from({ length: 1_000 }, (_, index) => ({
  turn: index + 1,
  prompt: `prompt ${String(index + 1)}`,
  response: '',
  anchor: { kind: 'loaded', key: `turn:${String(index + 1)}` },
}))
const t = makeTranslate(zh, commonZh)

describe('TurnNavigator', () => {
  it('places the latest committed active turn on its first viewport size without scroll commands', () => {
    const observer = installTurnNavigatorObserver(null)
    const onNavigate = vi.fn()
    const view = render(<TurnNavigator items={items} activeTurn={1} busyTurn={null} onNavigate={onNavigate} t={t} />)
    const nav = view.getByRole('navigation')
    const scroller = nav.firstElementChild as HTMLElement
    const scrollTo = vi.spyOn(scroller, 'scrollTo')
    const rect = vi.spyOn(scroller, 'getBoundingClientRect').mockImplementation(() => { throw new Error('synchronous rect read') })
    Object.defineProperty(scroller, 'scrollHeight', { get: () => { throw new Error('scroll extent read') } })
    Object.defineProperty(scroller, 'clientHeight', { get: () => { throw new Error('viewport height read') } })

    view.rerender(<TurnNavigator items={items} activeTurn={1_000} busyTurn={null} onNavigate={onNavigate} t={t} />)
    act(() => { observer.resize(300) })

    expect(scroller.scrollTop).toBe(9_702)
    expect(scrollTo).not.toHaveBeenCalled()
    expect(rect).not.toHaveBeenCalled()
    expect(within(nav).getAllByRole('button').length).toBeLessThan(40)
    expect(view.getByRole('button', { name: '跳转到第 1000 轮' }).getAttribute('aria-current')).toBe('true')
    expect(view.queryByRole('button', { name: '跳转到第 1 轮' })).toBeNull()
  })

  it('exposes separate activation and fixed-height scrolling controls without querying the scroll extent', async () => {
    installTurnNavigatorObserver()
    const ref = createRef<TurnNavigatorHandle>()
    const onNavigate = vi.fn()
    const view = render(<TurnNavigator ref={ref} items={items} activeTurn={1} busyTurn={null} onNavigate={onNavigate} t={t} />)
    await view.findByRole('button', { name: '跳转到第 1 轮' })
    const scroller = view.getByRole('navigation').firstElementChild as HTMLElement
    Object.defineProperty(scroller, 'scrollHeight', { get: () => { throw new Error('scroll extent read') } })
    Object.defineProperty(scroller, 'clientHeight', { get: () => { throw new Error('viewport height read') } })

    await act(async () => { ref.current?.scrollToTurn(500) })
    expect(scroller.scrollTop).toBe(4_846)
    expect(view.getByRole('button', { name: '跳转到第 500 轮' })).toBeTruthy()
    expect(onNavigate).not.toHaveBeenCalled()

    act(() => { ref.current?.activateTurn(700) })
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith(items[699])
    expect(scroller.scrollTop).toBe(4_846)
  })

  it('keeps keyboard focus mounted while scrolling to another virtual range', async () => {
    installTurnNavigatorObserver()
    const ref = createRef<TurnNavigatorHandle>()
    const view = render(
      <StrictMode>
        <TurnNavigator ref={ref} items={items} activeTurn={1} busyTurn={null} onNavigate={vi.fn()} t={t} />
      </StrictMode>,
    )
    const first = await view.findByRole('button', { name: '跳转到第 1 轮' })
    act(() => { first.focus() })
    await act(async () => { ref.current?.scrollToTurn(900) })

    expect(document.activeElement).toBe(first)
    expect(first.isConnected).toBe(true)
    expect(view.getByRole('button', { name: '跳转到第 900 轮' })).toBeTruthy()
    fireEvent.pointerEnter(view.getByRole('button', { name: '跳转到第 900 轮' }))
    expect(view.getByRole('tooltip').textContent).toBe('prompt 900')
    act(() => { first.blur() })
    expect(first.isConnected).toBe(false)
  })
})
