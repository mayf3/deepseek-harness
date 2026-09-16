/** XLSX formatting, cached formula results, and resource admission. */
import ExcelJS from 'exceljs'
import { strToU8, unzipSync, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { convertExcel } from '../src/client/excel/convert.ts'
import { Config } from '../src/config.ts'
import { excelFixture } from './excel-fixture.ts'

const limits = Config({}).excel

describe('Excel conversion', () => {
  it('keeps values, cached formulas, styles, merges, dimensions, visibility, and frozen headings', async () => {
    const input = await excelFixture()
    const { sheets, missingResults } = await convertExcel(input, 'xlsx', limits)
    expect(input.byteLength).toBeGreaterThan(0)
    expect(sheets.map(sheet => sheet.name)).toEqual(['季度预算', '公式与格式', '隐藏页'])
    const first = sheets[0]!
    const cell = (r: number, c: number) => first.celldata!.find(value => value.r === r && value.c === c)!.v
    expect(cell(0, 0)).toMatchObject({ v: 'DeepSeek · 项目预算', bl: 1, fs: 18, fc: '#FFFFFF', bg: '#3B5CCC', ht: 0, vt: 0, mc: { r: 0, c: 0, rs: 1, cs: 4 } })
    expect(cell(0, 1)).toMatchObject({ mc: { r: 0, c: 0 } })
    expect(cell(0, 1)).not.toHaveProperty('v')
    expect(cell(2, 3)).toMatchObject({ f: '=C3/B3', v: 0.8, m: '80.0%', ct: { fa: '0.0%', t: 'n' } })
    expect(cell(4, 1)).toMatchObject({ f: '=SUM(B3:B4)', v: 57000, m: '57,000.00' })
    expect(first.config).toMatchObject({ rowlen: { 0: 48 }, columnlen: { 0: 173 }, merge: { '0_0': { rs: 1, cs: 4 } } })
    expect(first.config!.borderInfo).toContainEqual({ rangeType: 'cell', value: { row_index: 1, col_index: 0, b: { style: 1, color: '#DCE2ED' } } })
    expect(first.frozen).toEqual({ type: 'rangeBoth', range: { row_focus: 1, column_focus: 0 } })
    expect(first.luckysheet_select_save).toEqual([{ row: [0, 0], column: [0, 3], row_focus: 0, column_focus: 0 }])
    const second = sheets[1]!
    expect(second.luckysheet_select_save).toEqual([{ row: [0, 0], column: [0, 0], row_focus: 0, column_focus: 0 }])
    expect(second.celldata).toEqual(expect.arrayContaining([
      expect.objectContaining({ r: 0, c: 0, v: expect.objectContaining({ f: '=_xlfn.XLOOKUP(1,{1},{42})', v: 42, m: '42' }) }),
      expect.objectContaining({ r: 1, c: 0, v: expect.objectContaining({ f: '=SUM(1,2)', m: '' }) }),
      expect.objectContaining({ r: 0, c: 1, v: expect.objectContaining({ m: '2026-09-16' }) }),
      expect.objectContaining({ r: 0, c: 2, v: expect.objectContaining({ v: '富文本 示例', ct: { t: 'inlineStr', s: expect.any(Array) } }) }),
      expect.objectContaining({ r: 0, c: 3, v: expect.objectContaining({ v: 'Link text' }) }),
      expect.objectContaining({ r: 2, c: 0, v: expect.objectContaining({ f: '=SUM(1,2)', v: 3 }) }),
      expect.objectContaining({ r: 3, c: 0, v: expect.objectContaining({ v: true }) }),
      expect.objectContaining({ r: 4, c: 0, v: expect.objectContaining({ v: '#DIV/0!' }) }),
    ]))
    expect(second.config).toMatchObject({ rowhidden: { 6: 0 }, colhidden: { 4: 0 }, rowlen: { 6: 40 * 96 / 72 } })
    expect(sheets[2]).toMatchObject({ hide: 1, status: 0 })
    expect(missingResults).toBe(1)
  })

  it('rejects damaged files, byte limits and sparse worksheets that would allocate a large matrix', async () => {
    await expect(convertExcel(new Uint8Array([1, 2, 3]), 'xlsx', limits)).rejects.toMatchObject({ code: 'invalid' })
    const input = await excelFixture()
    await expect(convertExcel(input, 'xlsx', { ...limits, maxBytes: input.byteLength - 1 })).rejects.toMatchObject({ code: 'tooLarge' })
    const workbook = new ExcelJS.Workbook()
    workbook.addWorksheet('Sparse').getCell('Z1000').value = 1
    await expect(convertExcel(new Uint8Array(await workbook.xlsx.writeBuffer()), 'xlsx', { ...limits, maxCells: 25_000 })).rejects.toMatchObject({ code: 'tooLarge' })
  })

  it('opens an empty worksheet and rejects workbooks with no visible sheet', async () => {
    const workbook = new ExcelJS.Workbook()
    workbook.addWorksheet('Empty')
    const result = await convertExcel(new Uint8Array(await workbook.xlsx.writeBuffer()), 'xlsx', limits)
    expect(result.sheets[0]).toMatchObject({ name: 'Empty', row: 1, column: 1, status: 1 })
    workbook.getWorksheet('Empty')!.state = 'veryHidden'
    await expect(convertExcel(new Uint8Array(await workbook.xlsx.writeBuffer()), 'xlsx', limits)).rejects.toMatchObject({ code: 'invalid' })
  })

  it.each([false, true])('retains dates for the 1904 epoch flag %s', async (date1904) => {
    const workbook = new ExcelJS.Workbook()
    workbook.properties.date1904 = date1904
    const cell = workbook.addWorksheet('Dates').getCell('A1')
    cell.value = new Date('2024-02-29T12:00:00Z')
    cell.numFmt = 'yyyy-mm-dd hh:mm'
    const result = await convertExcel(new Uint8Array(await workbook.xlsx.writeBuffer()), 'xlsx', limits)
    expect(result.sheets[0]!.celldata![0]!.v).toMatchObject({ m: '2024-02-29 12:00' })
  })

  it('maps custom colors, tints, alignment, decoration, and default dimensions', async () => {
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('Styles')
    sheet.properties.defaultColWidth = 12
    sheet.getColumn(1).width = 0.5
    const light = { theme: 4, tint: 0.5 }
    const dark = { theme: 4, tint: -0.5 }
    sheet.getCell('A1').value = 'Light'
    sheet.getCell('A1').font = { color: light, strike: true, underline: true }
    sheet.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: dark }
    sheet.getCell('A1').alignment = { horizontal: 'right', vertical: 'top', wrapText: true, textRotation: 'vertical' }
    sheet.getCell('B1').value = 'Rotated'
    sheet.getCell('B1').alignment = { horizontal: 'left', vertical: 'bottom', textRotation: 45 }
    sheet.getCell('B1').border = { top: { style: 'double' } }
    sheet.getCell('C1').value = 'Automatic color'
    sheet.getCell('C1').font = { color: { indexed: 64 } as Partial<ExcelJS.Color> }
    sheet.getCell('D1').value = 'Invalid color'
    sheet.getCell('D1').font = { color: { argb: 'invalid' } }
    sheet.getCell('E1').value = 'Untinted'
    sheet.getCell('E1').font = { color: { argb: 'FFFF0000', tint: 0 } as Partial<ExcelJS.Color> }
    sheet.getCell('F1').value = 42
    sheet.getCell('F1').alignment = { vertical: 'middle' }
    const result = await convertExcel(new Uint8Array(await workbook.xlsx.writeBuffer()), 'xlsx', limits)
    expect(result.sheets[0]).toMatchObject({ defaultColWidth: 89, config: { columnlen: { 0: 6 } } })
    const cells = result.sheets[0]!.celldata!
    expect(cells[0]!.v).toMatchObject({ fc: '#a7c0de', bg: '#28415f', cl: 1, un: 1, ht: 2, vt: 1, tb: '2', tr: '3' })
    expect(cells[1]!.v).toMatchObject({ ht: 1, vt: 2, rt: 45 })
    expect(cells[2]!.v).not.toHaveProperty('fc')
    expect(cells[3]!.v).not.toHaveProperty('fc')
    expect(cells[4]!.v).toMatchObject({ fc: '#FF0000' })
    expect(cells[5]!.v).toMatchObject({ v: 42, ht: 2, vt: 0, ct: { t: 'n' } })
  })

  it.each([{ ySplit: 2 }, { xSplit: 1 }, {}])('maps one-axis or empty freeze settings %j', async (freeze) => {
    const workbook = new ExcelJS.Workbook()
    workbook.addWorksheet('Frozen', { views: [{ state: 'frozen', ...freeze, showGridLines: false }] }).getCell('A1').value = 1
    const result = await convertExcel(new Uint8Array(await workbook.xlsx.writeBuffer()), 'xlsx', limits)
    expect(result.sheets[0]!.showGridLines).toBe(false)
    expect(result.sheets[0]!.frozen?.type).toBe('ySplit' in freeze ? 'rangeRow' : 'xSplit' in freeze ? 'rangeColumn' : undefined)
  })

  it('accepts workbooks without a theme and ignores absent theme colors', async () => {
    const files = unzipSync(await excelFixture())
    delete files['xl/theme/theme1.xml']
    expect((await convertExcel(new Uint8Array(zipSync(files)), 'xlsx', limits)).sheets).toHaveLength(3)
    files['xl/theme/theme1.xml'] = strToU8('<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:themeElements><a:clrScheme name="Custom"><a:lt1><a:sysClr val="window" lastClr="FEFEFE"/></a:lt1></a:clrScheme></a:themeElements></a:theme>')
    expect((await convertExcel(new Uint8Array(zipSync(files)), 'xlsx', limits)).sheets).toHaveLength(3)
  })
})
