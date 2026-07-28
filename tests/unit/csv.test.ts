import { describe, it, expect } from 'vitest'
import { toCsv, exportFilename, type Column } from '@/lib/reports/csv'

interface Row {
  name: string
  score: number | null
  when: string | null
}

const COLUMNS: Column<Row>[] = [
  { key: 'name', header: 'Name', kind: 'text' },
  { key: 'score', header: 'Score', kind: 'number' },
  { key: 'when', header: 'When', kind: 'date' },
]

/** The data rows of a rendered CSV, without the header. */
function body(csv: string): string[] {
  return csv.trimEnd().split('\r\n').slice(1)
}

describe('csv serialisation', () => {
  it('writes a header and one line per row', () => {
    const csv = toCsv<Row>([{ name: 'Asha', score: 8, when: null }], COLUMNS)
    expect(csv.split('\r\n')[0]).toBe('Name,Score,When')
    expect(body(csv)).toEqual(['Asha,8,'])
  })

  it('quotes values containing a comma, quote or newline', () => {
    const csv = toCsv<Row>(
      [
        { name: 'Patel, Asha', score: 1, when: null },
        { name: 'She said "yes"', score: 2, when: null },
        { name: 'two\nlines', score: 3, when: null },
      ],
      COLUMNS,
    )
    expect(body(csv)).toEqual([
      '"Patel, Asha",1,',
      '"She said ""yes""",2,',
      '"two\nlines",3,',
    ])
  })

  it('leaves an absent number empty rather than writing zero', () => {
    // The reports are careful that no data is not zero; the export must not
    // undo that on the way out of the building.
    const csv = toCsv<Row>([{ name: 'Quiet', score: null, when: null }], COLUMNS)
    expect(body(csv)).toEqual(['Quiet,,'])
  })

  describe('formula injection', () => {
    // A CSV is a file somebody opens in Excel, and every text column here is
    // authored by a user.
    it.each(['=1+1', '+1', '-1+1', '@SUM(A1)', '\tx', '\rx'])(
      'neutralises a text cell beginning %j',
      (raw) => {
        const csv = toCsv<Row>([{ name: raw, score: 1, when: null }], COLUMNS)
        const cell = body(csv)[0]
        expect(cell.startsWith("'") || cell.startsWith('"\'')).toBe(true)
      },
    )

    it('leaves a negative number alone', () => {
      // The usual "guard anything starting with -" advice would rewrite this
      // as '-4 and break every numeric column in the file.
      const csv = toCsv<Row>([{ name: 'Asha', score: -4, when: null }], COLUMNS)
      expect(body(csv)).toEqual(['Asha,-4,'])
    })

    it('does not disturb an ordinary value', () => {
      const csv = toCsv<Row>([{ name: 'Knife skills', score: 5, when: null }], COLUMNS)
      expect(body(csv)).toEqual(['Knife skills,5,'])
    })
  })

  it('renders a date as ISO and an unparseable one as empty', () => {
    const csv = toCsv<Row>(
      [
        { name: 'a', score: 1, when: '2026-07-28T10:00:00.000Z' },
        { name: 'b', score: 1, when: 'not a date' },
      ],
      COLUMNS,
    )
    expect(body(csv)[0]).toBe('a,1,2026-07-28T10:00:00.000Z')
    expect(body(csv)[1]).toBe('b,1,')
  })

  it('names the file by dataset and date', () => {
    expect(exportFilename('team', new Date('2026-07-28T09:00:00Z'))).toBe(
      'bookends-team-2026-07-28.csv',
    )
  })
})
