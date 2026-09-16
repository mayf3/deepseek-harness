/** One workbook per disposable parser Worker; formulas and external links are never executed. */
import { convertExcel, ExcelPreviewError, type ExcelLimits } from './convert.ts'

globalThis.onmessage = (event: MessageEvent<{ bytes: Uint8Array<ArrayBuffer>; limits: ExcelLimits }>) => {
  void convertExcel(event.data.bytes, event.data.limits).then(
    (value) => { globalThis.postMessage({ ok: true, value }) },
    (error: unknown) => { globalThis.postMessage({ ok: false, code: error instanceof ExcelPreviewError ? error.code : 'invalid' }) },
  )
}
