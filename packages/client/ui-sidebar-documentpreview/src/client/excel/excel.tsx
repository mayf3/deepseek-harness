/** Read-only spreadsheet surface backed by browser-parsed workbook data. */
import { useEffect, useState, type ReactNode } from 'react'
import { Workbook } from '@fortune-sheet/react'
import { Button, IconLoadingOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import fortuneCss from '@fortune-sheet/react/dist/index.css?inline'
import type { ExcelPreview } from './convert.ts'
import type { ExcelBodyProps } from './LazyExcelBody.tsx'
import { parseExcel } from './parse.ts'
import css from './ExcelBody.module.css'

type State = { data: Uint8Array<ArrayBuffer> } & ({ value: ExcelPreview } | { error: string })
const scopedStyles = `@scope ([data-excel-preview]) { ${fortuneCss} }`

/**
 * Display stored spreadsheet values and formats without editing or recalculation.
 * @param props - Complete workbook bytes, limits, and locale.
 * @returns An isolated spreadsheet surface with cancellable loading.
 */
export function ExcelBody({ content, limits, t }: ExcelBodyProps): ReactNode {
  const data = content.kind === 'bytes' ? content.data : undefined
  const [state, setState] = useState<State>()
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (data === undefined) return
    const controller = new AbortController()
    setState(undefined)
    void parseExcel(data, limits, controller.signal).then(
      (value) => { if (!controller.signal.aborted) setState({ data, value }) },
      (error: unknown) => { if (!controller.signal.aborted) setState({ data, error: error instanceof Error ? error.message : 'invalid' }) },
    )
    return () => { controller.abort() }
  }, [data, limits, attempt])
  if (data === undefined) return <p className={css.status} role="alert">{t('invalid')}</p>
  if (state?.data !== data) return <span className={css.status} role="status" aria-label={t('loading')} data-document-loading>
    <span className={css.loadingIcon} aria-hidden="true"><IconLoadingOutlineRegular /></span>
  </span>
  if ('error' in state) return <div className={css.status} role="alert">
    <span>{t(state.error === 'tooLarge' ? 'tooLarge' : state.error === 'timeout' ? 'timeout' : 'invalid')}</span>
    <Button size="sm" onClick={() => { setAttempt(value => value + 1) }}>{t('retry')}</Button>
  </div>
  return <section className={css.body} data-excel-preview aria-label={t('title')}>
    <style>{scopedStyles}</style>
    <p className={css.notice} title={t('limitations')}>{t('summary')}</p>
    {state.value.missingResults > 0 && <p className={css.notice} role="status">{t('missingResults')}</p>}
    <div className={css.workbook}>
      <Workbook key={`${attempt}:${t('language')}`} data={state.value.sheets} lang={t('language')}
        allowEdit={false} showToolbar={false} showFormulaBar showSheetTabs forceCalculation={false}
        cellContextMenu={['copy']} headerContextMenu={[]} sheetTabContextMenu={[]} filterContextMenu={[]} />
    </div>
  </section>
}
