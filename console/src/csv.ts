/**
 * CSV exports, built in the browser from data a page already fetched.
 *
 * Numbers are written as they are. Text is quoted when it holds a quote, a
 * comma or a line break, and a cell that a spreadsheet would read as a formula
 * (starting = + - @, or a tab or carriage return) gets a leading apostrophe:
 * a product title or order reference is text a merchant or shopper typed, and
 * "=HYPERLINK(...)" should open as those characters, not as a link. A plain
 * signed number such as '-12.50' is left alone, so amounts stay numbers.
 */
export type Cell = string | number | null

const FORMULA = /^[=+\-@\t\r]/
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/

function cell(value: Cell): string {
  if (value === null) return ''
  if (typeof value === 'number') return String(value)
  const text = FORMULA.test(value) && !PLAIN_NUMBER.test(value) ? `'${value}` : value
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** Rows to CSV text, CRLF between rows as RFC 4180 has it. */
export const toCsv = (rows: Cell[][]): string => rows.map((r) => r.map(cell).join(',')).join('\r\n')

/** Written as an escape: a literal BOM in source is invisible, and editors strip it. */
export const BOM = '\uFEFF'

/** Hands the browser a file to save. The BOM makes Excel read UTF-8 as UTF-8. */
export function download(name: string, rows: Cell[][]): void {
  const url = URL.createObjectURL(new Blob([BOM, toCsv(rows)], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  // Revoked after the click has been handled: some browsers start the download
  // asynchronously and fail it if the URL is already gone.
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
