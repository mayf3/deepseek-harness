/** Real XLSX fixture shared by adapter and shipped-profile browser tests. */
import ExcelJS from 'exceljs'

/**
 * Build a styled, multi-sheet workbook with cached and unsupported formulas.
 * @returns Complete XLSX file bytes.
 */
export async function excelFixture(): Promise<Uint8Array<ArrayBuffer>> {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('季度预算', { views: [{ state: 'frozen', xSplit: 1, ySplit: 2 }] })
  sheet.columns = [{ width: 24 }, { width: 18 }, { width: 18 }, { width: 18 }]
  sheet.mergeCells('A1:D1')
  sheet.getCell('A1').value = 'DeepSeek · 项目预算'
  sheet.getCell('A1').font = { name: 'Arial', size: 18, bold: true, color: { argb: 'FFFFFFFF' } }
  sheet.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF3B5CCC' } }
  sheet.getCell('A1').alignment = { horizontal: 'center', vertical: 'middle' }
  sheet.getRow(1).height = 36
  sheet.getRow(2).values = ['项目', '预算', '支出', '执行率']
  sheet.getRow(3).values = ['设计', 12000, 9600, { formula: 'C3/B3', result: 0.8 }]
  sheet.getRow(4).values = ['研发', 45000, 31500, { formula: 'C4/B4', result: 0.7 }]
  sheet.getRow(5).values = ['合计', { formula: 'SUM(B3:B4)', result: 57000 }, { formula: 'SUM(C3:C4)', result: 41100 }, { formula: 'C5/B5', result: 41100 / 57000 }]
  for (let row = 2; row <= 5; row += 1) {
    sheet.getRow(row).height = 28
    for (let column = 1; column <= 4; column += 1) {
      const cell = sheet.getCell(row, column)
      cell.border = { bottom: { style: 'thin', color: { argb: 'FFDCE2ED' } } }
      if (row === 2 || row === 5) {
        cell.font = { bold: true, color: { argb: 'FF24345C' } }
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEDF1FC' } }
      }
      if (row > 2 && column > 1) cell.numFmt = column === 4 ? '0.0%' : '#,##0.00'
    }
  }
  const details = workbook.addWorksheet('公式与格式')
  details.getCell('A1').value = { formula: '_xlfn.XLOOKUP(1,{1},{42})', result: 42 }
  details.getCell('A2').value = { formula: 'SUM(1,2)' }
  details.getCell('B1').value = new Date('2026-09-16T00:00:00Z')
  details.getCell('B1').numFmt = 'yyyy-mm-dd'
  details.getCell('C1').value = { richText: [{ text: '富文本', font: { bold: true } }, { text: ' 示例', font: { italic: true } }] }
  details.getCell('D1').value = { text: 'Link text', hyperlink: 'https://example.com' }
  details.getCell('A3').value = { sharedFormula: 'A2', result: 3 }
  details.getCell('A4').value = true
  details.getCell('A5').value = { error: '#DIV/0!' }
  details.getRow(7).height = 40
  details.getRow(7).hidden = true
  details.getColumn(5).hidden = true
  workbook.addWorksheet('隐藏页', { state: 'hidden' }).getCell('A1').value = 'Hidden data'
  return new Uint8Array(await workbook.xlsx.writeBuffer())
}

/** Cell text whose markup and ampersand must remain literal in the preview and clipboard. */
export const excelHtmlText = '<span><img src=data:, onerror=document.documentElement.dataset.spreadsheetHtml=1></span>& literal'

/**
 * Build a workbook carrying HTML-looking formulas, text, and saved formula results.
 * @returns Complete XLSX file bytes.
 */
export async function excelHtmlFixture(): Promise<Uint8Array<ArrayBuffer>> {
  const workbook = new ExcelJS.Workbook()
  workbook.addWorksheet('Formula').getCell('A1').value = { formula: `"${excelHtmlText}"`, result: 'saved result' }
  workbook.addWorksheet('Text').getCell('A1').value = excelHtmlText
  workbook.addWorksheet('Cached text').getCell('A1').value = { formula: '"cached"', result: excelHtmlText }
  return new Uint8Array(await workbook.xlsx.writeBuffer())
}
