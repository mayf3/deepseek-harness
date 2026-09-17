// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { en, zh } from '../src/client/locales.ts'
import { PlanCard, PlanReviewOpen } from '../src/client/PlanCard.tsx'
import { PlanPreview, PlanTitle } from '../src/client/PlanPreview.tsx'
import { planAddress, parsePlanAddress, submittedPlan } from '../src/client/plan.ts'
import { planDefinition } from '../src/client/plan-definition.ts'

afterEach(cleanup)
const markdown = '# Keep this plan\n\n## Goal\n\n- Review\n- Implement'
const call = { type: 'tool/call', data: { name: 'exit_plan_mode', callId: 'call:1', arguments: JSON.stringify({ plan: markdown }) } }
const plan = submittedPlan(call)!
const target = { sessionId: 'session / 中文' as SessionId, callId: plan.callId }
const t = makeTranslate(en, commonEn)

describe('submitted plan identity', () => {
  it('reads native, running PTC, and settled PTC calls', () => {
    expect(plan).toEqual({ callId: 'call:1', title: 'Keep this plan', markdown })
    for (const type of ['tool/ptc-dispatch-start', 'tool/ptc-dispatch']) {
      expect(submittedPlan({ type, data: { name: 'exit_plan_mode', subCallId: 'call:1', arguments: { plan: markdown } } })).toEqual(plan)
    }
  })
  it.each([
    { type: 'user/message', data: call.data },
    { type: 'tool/call', data: null },
    { type: 'tool/call', data: [] },
    { type: 'tool/call', data: { ...call.data, name: 'read' } },
    { type: 'tool/call', data: { ...call.data, callId: '' } },
    { type: 'tool/call', data: { ...call.data, arguments: {} } },
    { type: 'tool/call', data: { ...call.data, arguments: '{' } },
    { type: 'tool/call', data: { ...call.data, arguments: 'null' } },
    { type: 'tool/call', data: { ...call.data, arguments: '{"plan":42}' } },
    { type: 'tool/call', data: { ...call.data, arguments: '{"plan":"no title"}' } },
  ])('leaves malformed or unrelated input to its existing renderer: %j', (event) => {
    expect(submittedPlan(event)).toBeUndefined()
  })
  it('round-trips opaque identifiers and refuses malformed addresses', () => {
    expect(parsePlanAddress(planAddress(target))).toEqual(target)
    for (const address of ['file:///plan.md', 'dsh-resource://plan/s/c/extra', 'dsh-resource://plan/s/%XX', 'dsh-resource://plan/s/c?text=x']) {
      expect(parsePlanAddress(address)).toBeUndefined()
    }
  })
  it('keeps a settled PTC update correlated with its existing card', () => {
    expect(planDefinition.match(call as never)).toEqual({ id: plan.callId, role: 'start' })
    const event = { type: 'tool/ptc-dispatch', data: { name: 'exit_plan_mode', subCallId: plan.callId, arguments: { plan: markdown } } }
    expect(planDefinition.match(event as never)).toEqual({ id: plan.callId, role: 'update' })
    const context = { key: 'plan', id: plan.callId, state: plan, start: { event: { seq: 12 }, location: { kind: 'unresolved' } } }
    expect(planDefinition.buildViewNode!(context as never)).toMatchObject({ process: 'independent', anchorSeq: 12, data: plan })
    expect(planDefinition.buildViewNode!({ ...context, state: undefined, start: undefined, matches: [] } as never)).toBeNull()
  })
  it('retains the submitted version and recovers a cropped PTC start from settlement', () => {
    expect(planDefinition.match({ type: 'user/message', data: {} } as never)).toBeNull()
    const state = planDefinition.start({} as never, { event: call } as never, {} as never)
    expect(state).toEqual(plan)
    expect(planDefinition.update({ state } as never, {} as never)).toBe(state)
    const settled = { event: { type: 'tool/ptc-dispatch', seq: 21, data: { name: 'exit_plan_mode', subCallId: plan.callId, arguments: { plan: markdown } } }, location: { kind: 'unresolved' } }
    expect(planDefinition.buildViewNode!({ key: 'plan', id: plan.callId, matches: [settled] } as never)).toMatchObject({ anchorSeq: 21, data: plan })
  })
})

describe('plan entry points and document', () => {
  it('opens the exact persistent card in either locale', () => {
    for (const dictionary of [en, zh]) {
      const openPlan = vi.fn()
      const props = { node: { data: plan }, t: makeTranslate(dictionary, commonEn), openPlan } as unknown as Parameters<typeof PlanCard>[0]
      const view = render(<PlanCard {...props} />)
      fireEvent.click(screen.getByRole('button'))
      expect(openPlan).toHaveBeenCalledWith(plan.callId)
      expect(screen.getByText(plan.title)).toBeTruthy()
      view.unmount()
    }
  })
  it('opens the review without approving or cancelling it', () => {
    const openPlan = vi.fn()
    const props = { review: { callId: plan.callId }, t, openPlan } as unknown as Parameters<typeof PlanReviewOpen>[0]
    const view = render(<PlanReviewOpen {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open plan in sidebar' }))
    expect(openPlan).toHaveBeenCalledWith(plan.callId)
    view.rerender(<PlanReviewOpen {...{ review: {}, t, openPlan } as unknown as Parameters<typeof PlanReviewOpen>[0]} />)
    expect(screen.queryByRole('button')).toBeNull()
  })
  it('shows restored Markdown and its heading as the tab title', () => {
    const props = {
      t, useTabInfo: () => ({ tab: { title: 'Plan', navigation: { address: planAddress(target) } } }),
      useResource: () => ({ status: 'live', value: plan }),
    }
    render(<PlanPreview {...props as unknown as Parameters<typeof PlanPreview>[0]} />)
    expect(screen.getByRole('heading', { name: plan.title })).toBeTruthy()
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    cleanup()
    render(<PlanTitle {...props as unknown as Parameters<typeof PlanTitle>[0]} />)
    expect(screen.getByText(plan.title)).toBeTruthy()
  })
  it('copies the complete Markdown and keeps a tab label while history loads', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    try {
      const props = { t, useTabInfo: () => ({ tab: { title: 'Plan', navigation: { address: planAddress(target) } } }), useResource: () => ({ status: 'live', value: plan }) }
      const view = render(<PlanPreview {...props as unknown as Parameters<typeof PlanPreview>[0]} />)
      fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
      await Promise.resolve()
      expect(writeText).toHaveBeenCalledWith(markdown)
      view.rerender(<PlanTitle {...{ ...props, useResource: () => ({ status: 'loading' }) } as unknown as Parameters<typeof PlanTitle>[0]} />)
      expect(screen.getByText('Plan')).toBeTruthy()
    } finally {
      if (clipboard === undefined) Reflect.deleteProperty(navigator, 'clipboard')
      else Object.defineProperty(navigator, 'clipboard', clipboard)
    }
  })
  it('shows loading and failed reads without an empty sidebar', () => {
    const props = { t, useTabInfo: () => ({ tab: { title: 'Plan', navigation: { address: planAddress(target) } } }) }
    const view = render(<PlanPreview {...{ ...props, useResource: () => ({ status: 'loading' }) } as unknown as Parameters<typeof PlanPreview>[0]} />)
    expect(screen.getByRole('status').textContent).toBe('Loading plan…')
    view.rerender(<PlanPreview {...{ ...props, useResource: () => ({ status: 'failed', failure: { message: 'gone' } }) } as unknown as Parameters<typeof PlanPreview>[0]} />)
    expect(screen.getByRole('status').textContent).toContain('Could not load plan')
    expect(screen.getByText('gone')).toBeTruthy()
  })
})
