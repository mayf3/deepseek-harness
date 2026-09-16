// @vitest-environment jsdom
/** Excel preview lifecycle and read-only renderer settings. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { Config } from '../src/config.ts'
import { en } from '../src/client/excel/locales.ts'
import type { ExcelBodyProps, LoadedExcelBodyProps } from '../src/client/excel/LazyExcelBody.tsx'

const mocked = vi.hoisted(() => ({ parse: vi.fn(), workbook: vi.fn((_props: unknown) => null) }))
vi.mock('../src/client/excel/parse.ts', () => ({ parseExcel: mocked.parse }))
vi.mock('@fortune-sheet/react', () => ({ Workbook: mocked.workbook }))
import { ExcelBody } from '../src/client/excel/excel.tsx'
import { LazyExcelBody } from '../src/client/excel/LazyExcelBody.tsx'

const props = { content: { kind: 'bytes', data: new Uint8Array([1]) }, limits: Config({}).excel, t: makeTranslate(en), resourceAddress: 'dsh-resource://file/session/s1/book.xlsx' } as ExcelBodyProps
const loadedProps = { ...props, format: 'xlsx' } as LoadedExcelBodyProps
const value = { sheets: [{ name: 'Budget', celldata: [] }], missingResults: 0 }
afterEach(() => { cleanup(); vi.resetAllMocks() })

it('shows loading then a workbook with editing and recalculation disabled', async () => {
  mocked.parse.mockResolvedValue({ ...value, missingResults: 1 })
  const view = render(<ExcelBody {...loadedProps} />)
  expect(screen.getByRole('status', { name: en.loading })).toBeDefined()
  await screen.findByText(en.summary)
  expect(screen.getByText(en.missingResults)).toBeDefined()
  expect(mocked.workbook.mock.calls[0]![0]).toMatchObject({ data: value.sheets, allowEdit: false, forceCalculation: false, showToolbar: false, showSheetTabs: true, lang: 'en', cellContextMenu: ['copy'] })
  const signal = mocked.parse.mock.calls[0]![3] as AbortSignal
  view.unmount()
  expect(signal.aborted).toBe(true)
})

it('ignores a retired file result and cancels parsing when the bytes change', async () => {
  let finish!: (value: unknown) => void
  mocked.parse.mockReturnValueOnce(new Promise((resolve) => { finish = resolve })).mockResolvedValueOnce(value)
  const view = render(<ExcelBody {...loadedProps} />)
  const signal = mocked.parse.mock.calls[0]![3] as AbortSignal
  view.rerender(<ExcelBody {...loadedProps} content={{ kind: 'bytes', data: new Uint8Array([2]) }} />)
  await screen.findByText(en.summary)
  expect(signal.aborted).toBe(true)
  finish({ ...value, missingResults: 1 })
  await waitFor(() => { expect(screen.queryByText(en.missingResults)).toBeNull() })
})

it.each(['invalid', 'tooLarge', 'timeout', 'encoding', 'unexpected'])('shows localized %s errors and retries explicitly', async (error) => {
  mocked.parse.mockRejectedValueOnce(new Error(error)).mockResolvedValueOnce(value)
  render(<ExcelBody {...loadedProps} />)
  const key = error === 'tooLarge' || error === 'timeout' || error === 'encoding' ? error : 'invalid'
  await screen.findByText(en[key])
  fireEvent.click(screen.getByRole('button', { name: en.retry }))
  await screen.findByText(en.summary)
  expect(mocked.parse).toHaveBeenCalledTimes(2)
})

it('rejects non-byte content without allocating a parser', () => {
  render(<ExcelBody {...loadedProps} content={{ kind: 'text', text: '', pages: [], eof: true }} />)
  expect(screen.getByRole('alert').textContent).toBe(en.invalid)
  expect(mocked.parse).not.toHaveBeenCalled()
})

it.each(['xlsx', 'xls', 'csv', 'tsv'])('loads the spreadsheet chunk for %s', async (format) => {
  mocked.parse.mockResolvedValue(value)
  render(<LazyExcelBody {...props} resourceAddress={`dsh-resource://file/session/s1/book.${format}`} />)
  await screen.findByText(format === 'csv' || format === 'tsv' ? en.textSummary : en.summary)
  expect(mocked.parse.mock.calls[0]![1]).toBe(format)
})

it('uses generic guidance for non-Error failures and ignores rejection after unmount', async () => {
  mocked.parse.mockRejectedValueOnce('parser failure')
  const view = render(<ExcelBody {...loadedProps} />)
  await screen.findByText(en.invalid)
  view.unmount()
  let reject!: (error: Error) => void
  mocked.parse.mockReturnValueOnce(new Promise((_resolve, fail) => { reject = fail }))
  const pending = render(<ExcelBody {...loadedProps} />)
  const signal = mocked.parse.mock.calls[1]![3] as AbortSignal
  pending.unmount()
  reject(new Error('closed'))
  await waitFor(() => { expect(signal.aborted).toBe(true) })
})
