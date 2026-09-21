// @vitest-environment jsdom

import { expect, it, onTestFinished, vi } from 'vitest'
import { ChatViewport } from '../src/client/chat/use-chat-viewport.ts'

function fixture() {
  const column = document.createElement('div')
  column.dataset.chatFlow = ''
  document.body.append(column)
  const viewport = new ChatViewport()
  const hitTest = Object.getOwnPropertyDescriptor(document, 'elementsFromPoint')
  Object.defineProperty(document, 'elementsFromPoint', { configurable: true, value: undefined })
  onTestFinished(() => {
    viewport.detach()
    column.remove()
    if (hitTest === undefined) Reflect.deleteProperty(document, 'elementsFromPoint')
    else Object.defineProperty(document, 'elementsFromPoint', hitTest)
    vi.restoreAllMocks()
  })
  Object.defineProperties(column, {
    clientHeight: { configurable: true, value: 300 },
    scrollHeight: { configurable: true, value: 2_000 },
  })
  vi.spyOn(column, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 500, 300))
  viewport.attach(column, column)
  let prependedHeight = 0
  const group = () => {
    const element = document.createElement('div')
    element.dataset.chatGroupKey = 'group'
    element.style.display = 'contents'
    column.append(element)
    return element
  }
  const row = (parent: HTMLElement, nodeKey: string, top: number, part?: string) => {
    const element = document.createElement('div')
    element.textContent = nodeKey
    element.dataset.chatNodeKey = nodeKey
    element.dataset.chatAnchorKey = part === undefined ? nodeKey : JSON.stringify([nodeKey, part])
    element.dataset.chatFlowKey = element.dataset.chatAnchorKey
    element.dataset.chatTurn = '1'
    parent.append(element)
    vi.spyOn(element, 'getBoundingClientRect').mockImplementation(() =>
      new DOMRect(0, top + prependedHeight - column.scrollTop, 500, 60))
    return element
  }
  return { column, viewport, group, row, prepend: (height: number) => { prependedHeight += height } }
}

it('captures a grouped member and preserves its reading position after history grows above it', () => {
  const h = fixture()
  const group = h.group()
  h.row(group, 'first', 20)
  h.row(group, 'second', 130)
  h.column.scrollTop = 100

  const position = h.viewport.capturePosition()
  expect(position).toEqual({ anchorKey: 'second', anchorTop: 30, scrollTop: 100 })
  if (position === null) throw new Error('expected a grouped reading anchor')
  h.prepend(200)
  const landing = h.viewport.preserve(position)
  expect(landing?.metrics.top).toBe(300)
  expect(landing?.position).toEqual({ anchorKey: 'second', anchorTop: 30, scrollTop: 300 })
})

it('navigates by Node identity while retaining a distinct visible part anchor', () => {
  const h = fixture()
  const group = h.group()
  const reasoning = h.row(group, 'assistant', 100, 'reasoning')
  const response = h.row(group, 'assistant', 200, 'response')
  h.viewport.updateTurns([{ turn: 1, anchorKey: 'assistant', prompt: '', response: '' }])

  expect(h.viewport.scrollToTurn(1)?.position?.anchorKey).toBe(reasoning.dataset.chatAnchorKey)
  reasoning.setAttribute('hidden', 'until-found')
  const landing = h.viewport.scrollToTurn(1)
  expect(landing?.metrics.top).toBe(176)
  expect(landing?.position?.anchorKey).toBe(response.dataset.chatAnchorKey)
  expect(h.viewport.restore({ anchorKey: response.dataset.chatAnchorKey!, anchorTop: 8, scrollTop: 0 })?.metrics.top)
    .toBe(192)
})

it('excludes empty rows, hidden ancestors, and transparent group shells from fallback sampling', () => {
  const h = fixture()
  const hidden = h.group()
  hidden.setAttribute('hidden', 'until-found')
  h.row(hidden, 'hidden', 10)
  const group = h.group()
  group.dataset.chatFlowKey = 'group'
  group.dataset.chatAnchorKey = 'group'
  const empty = h.row(group, 'empty', 30)
  empty.textContent = ''
  h.row(group, 'visible', 70)

  expect(h.viewport.capturePosition()?.anchorKey).toBe('visible')
})

it('skips hidden group members when navigating to a fallback Turn row', () => {
  const h = fixture()
  const hidden = h.group()
  hidden.setAttribute('hidden', 'until-found')
  h.row(hidden, 'hidden', 10, 'reasoning')
  const visible = h.row(h.group(), 'visible', 150, 'response')

  const landing = h.viewport.scrollToTurnAtOrAfter(1)
  expect(landing?.metrics.top).toBe(126)
  expect(landing?.position?.anchorKey).toBe(visible.dataset.chatAnchorKey)
})

it('retains the original capture and Turn navigation path for ungrouped Nodes', () => {
  const h = fixture()
  h.row(h.column, 'whole', 90)
  h.viewport.updateTurns([{ turn: 1, anchorKey: 'whole', prompt: '', response: '' }])
  expect(h.viewport.capturePosition()?.anchorKey).toBe('whole')
  expect(h.viewport.scrollToTurn(1)?.metrics.top).toBe(66)
})
