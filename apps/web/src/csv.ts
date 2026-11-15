/**
 * CSV for the phone.
 *
 * Reports are exported on the phone itself, so there is no server to format
 * them. Cells are quoted only when they need it and values that a spreadsheet
 * would evaluate as a formula are defused.
 */

export interface CsvColumn<T> {
  header: string;
  value: (row: T) => string | number | null | undefined;
}

const FORMULA_PREFIX = /^[=+\-@\t\r]/;

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (typeof value === 'string' && FORMULA_PREFIX.test(text)) text = `'${text}`;
  if (/[",\r\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

export function toCsv<T>(columns: readonly CsvColumn<T>[], rows: readonly T[]): string {
  const lines = [columns.map((column) => csvCell(column.header)).join(',')];
  for (const row of rows) {
    lines.push(columns.map((column) => csvCell(column.value(row))).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

export function reportFilename(kind: string, startDay: string, endDay: string): string {
  const safe = kind
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `farmatics-${safe}-${startDay}-to-${endDay}.csv`;
}
