// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ScheduleCatalogEntry } from '@deepseek-ai/dsh-schedule/client'
import type { CatalogSnapshot } from '../src/client/catalog-source.ts'
import {
  SchedulePluginActivation, SchedulePluginUsage,
  type SchedulePluginActivationProps, type SchedulePluginUsageProps,
} from '../src/client/SchedulePluginUsage.tsx'
import { en, zh } from '../src/client/task-manager-locales.ts'

afterEach(cleanup)

function props(status: CatalogSnapshot['status'] = 'ready', enabled = true): SchedulePluginUsageProps {
  const snapshot: CatalogSnapshot<ScheduleCatalogEntry> = {
    status, records: [], deleting: [], settled: status === 'ready', readRequest: 1,
    readSettled: status === 'ready' ? 1 : 0,
  }
  return {
    pkg: { name: '@deepseek-ai/dsh-experimental-schedule-bundle', installed: false, enabled, rows: [] },
    useCatalog: selector => selector(snapshot),
    onRetry: vi.fn().mockResolvedValue(undefined),
    onOpenAutomation: vi.fn(),
    t: makeTranslate(en),
  } as SchedulePluginUsageProps
}

function activation(status: CatalogSnapshot['status'] = 'ready'): SchedulePluginActivationProps {
  return {
    ...props(status), packageName: '@deepseek-ai/dsh-experimental-schedule-bundle',
    onDismiss: vi.fn(), onOpenDetails: vi.fn(),
  }
}

describe('Schedule plugin usage', () => {
  it('explains the live capability and opens the task page only on a click', () => {
    const value = props()
    render(<SchedulePluginUsage {...value} />)
    expect(screen.getByText('Automation tasks are ready to use')).toBeTruthy()
    expect(screen.getByText('Sidebar · Automation tasks')).toBeTruthy()
    expect(screen.getByText('Continue the original session at a scheduled time or on a repeating schedule.')).toBeTruthy()
    expect(value.onOpenAutomation).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Open automation tasks' }))
    expect(value.onOpenAutomation).toHaveBeenCalledOnce()
  })

  it('hides an explicitly disabled bundle and localizes a ready bundle', () => {
    const value = props('ready', false)
    const view = render(<SchedulePluginUsage {...value} />)
    expect(screen.queryByRole('region')).toBeNull()
    view.rerender(<SchedulePluginUsage {...props()} t={makeTranslate(zh)} />)
    expect(screen.getByText('自动化任务已可使用')).toBeTruthy()
    expect(screen.getByText('侧栏 · 自动化任务')).toBeTruthy()
    expect(screen.getByRole('button', { name: '打开自动化任务' })).toBeTruthy()
  })

  it('does not announce readiness until a catalog query succeeds and retries failures', () => {
    const loading = props('loading')
    const view = render(<SchedulePluginUsage {...loading} />)
    expect(screen.getByText('Checking automation tasks…')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Open automation tasks' }))
    expect(loading.onOpenAutomation).not.toHaveBeenCalled()
    const failed = props('error')
    view.rerender(<SchedulePluginUsage {...failed} />)
    expect(screen.getByText('Automation tasks are currently unavailable')).toBeTruthy()
    expect(screen.queryByText('Automation tasks are ready to use')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(failed.onRetry).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'Open automation tasks' }))
    expect(failed.onOpenAutomation).not.toHaveBeenCalled()
  })
})

describe('Schedule activation guidance', () => {
  it('dismisses the guidance before opening the task page', () => {
    const value = activation()
    const calls: string[] = []
    render(<SchedulePluginActivation {...value} onDismiss={() => { calls.push('close') }} onOpenAutomation={() => { calls.push('open') }} />)
    expect(screen.getByRole('dialog', { name: 'Use automation tasks' })).toBeTruthy()
    expect(calls).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: 'Open automation tasks' }))
    expect(calls).toEqual(['close', 'open'])
  })

  it('keeps failed activation guidance dismissible with a retry and no ready claim', () => {
    const value = activation('error')
    render(<SchedulePluginActivation {...value} />)
    expect(screen.getByText('Automation tasks are currently unavailable')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(value.onRetry).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'Open automation tasks' }))
    expect(value.onOpenAutomation).not.toHaveBeenCalled()
    fireEvent.click(screen.getAllByRole('button', { name: 'Close' })[0]!)
    expect(value.onDismiss).toHaveBeenCalledOnce()
  })
})
