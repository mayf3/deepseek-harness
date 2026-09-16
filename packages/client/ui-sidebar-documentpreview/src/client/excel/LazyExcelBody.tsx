/** Load the spreadsheet renderer only when a supported workbook is opened. */
import { lazy, Suspense, type ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { DocumentPreviewProps } from '../document/contract.ts'
import type { ExcelLimits } from './convert.ts'
import { hostFileOf } from '../rpc.ts'
import { LoadingIndicator } from '../LoadingIndicator.tsx'
import css from '../TextPreview.module.css'

/** Document input plus parser limits and localized copy. */
export type ExcelBodyProps = DocumentPreviewProps & PropsLocale<'sidebarExcel'> & { readonly limits: ExcelLimits }

const LoadedExcelBody = lazy(async () => ({ default: (await import('./excel.tsx')).ExcelBody }))

/**
 * Show legacy-format guidance or load the browser workbook renderer.
 * @param props - Complete file bytes and standard document seats.
 * @returns Localized loading state or Excel preview.
 */
export function LazyExcelBody(props: ExcelBodyProps): ReactNode {
  if (/\.xls$/iu.test(hostFileOf(props.resourceAddress).path)) return <p className={css.status} role="alert">{props.t('legacy')}</p>
  return <Suspense fallback={<LoadingIndicator className={css.status} label={props.t('loading')} />}>
    <LoadedExcelBody {...props} />
  </Suspense>
}
