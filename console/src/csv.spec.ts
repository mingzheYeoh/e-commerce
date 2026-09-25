import { describe, it, expect } from 'vitest'
import { toCsv } from './csv'
import { minorToDecimal, formatBps, change } from './money'

describe('toCsv', () => {
  it('quotes a cell with a quote, a comma or a line break, and doubles its quotes', () => {
    expect(toCsv([['plain', 'a,b', 'say "hi"', 'two\nlines', 'cr\rhere']])).toBe(
      'plain,"a,b","say ""hi""","two\nlines","cr\rhere"',
    )
  })

  it('joins rows with CRLF and writes numbers and nulls as they are', () => {
    expect(toCsv([['id', 'qty'], ['o1', 3], ['o2', null]])).toBe('id,qty\r\no1,3\r\no2,')
  })

  it('defuses a cell a spreadsheet would run as a formula, and leaves signed amounts as numbers', () => {
    expect(
      toCsv([['=HYPERLINK("http://x","y")', '+1+1', '-1+1', '@SUM(A1)', '\tx', '-12.50', '-7', '1-2']]),
    ).toBe(`"'=HYPERLINK(""http://x"",""y"")",'+1+1,'-1+1,'@SUM(A1),'\tx,-12.50,-7,1-2`)
  })
})

describe('money for exports', () => {
  it('writes minor units as an exact plain decimal', () => {
    expect([0, 5, 100, 123456, -250, -5, 9_007_199_254_740_991].map(minorToDecimal)).toEqual([
      '0.00',
      '0.05',
      '1.00',
      '1234.56',
      '-2.50',
      '-0.05',
      '90071992547409.91',
    ])
  })

  it('shows a rate and a change as percentages', () => {
    expect([800, 333, 1000, 0].map(formatBps)).toEqual(['8%', '3.33%', '10%', '0%'])
    expect(change(150, 100)).toBe('+50%')
    expect(change(95, 100)).toBe('-5.0%')
    expect(change(5, 0), 'nothing to compare with').toBeNull()
  })
})
