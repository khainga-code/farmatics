import { describe, expect, it } from 'vitest';
import { csvCell, reportFilename, toCsv } from '../src/csv.js';

/**
 * Spreadsheet-safe CSV built on the phone. These cases are the ones that
 * corrupt exports or execute in a spreadsheet when they are missed.
 */

describe('csv cells', () => {
  it('leaves plain values alone', () => {
    expect(csvCell('Batch A')).toBe('Batch A');
    expect(csvCell(1200)).toBe('1200');
    expect(csvCell(true)).toBe('true');
  });

  it('quotes commas, quotes and newlines', () => {
    expect(csvCell('Feed, water')).toBe('"Feed, water"');
    expect(csvCell('He said "hello"')).toBe('"He said ""hello"""');
    expect(csvCell('line one\nline two')).toBe('"line one\nline two"');
  });

  it('writes null and undefined as empty cells', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });

  it('defuses strings a spreadsheet would treat as a formula', () => {
    expect(csvCell('=SUM(A1:A2)')).toBe("'=SUM(A1:A2)");
    expect(csvCell('+254700000000')).toBe("'+254700000000");
    expect(csvCell('-note')).toBe("'-note");
    expect(csvCell('@name')).toBe("'@name");
    // A number is data, not a formula.
    expect(csvCell(-5)).toBe('-5');
  });
});

describe('csv documents', () => {
  const columns = [
    { header: 'Batch', value: (row: { code: string; birds: number }) => row.code },
    { header: 'Birds', value: (row: { code: string; birds: number }) => row.birds },
  ];

  it('writes a header, rows and CRLF line endings', () => {
    expect(toCsv(columns, [{ code: 'A,1', birds: 10 }])).toBe(
      'Batch,Birds\r\n"A,1",10\r\n',
    );
  });

  it('writes a header alone when there are no rows', () => {
    expect(toCsv(columns, [])).toBe('Batch,Birds\r\n');
  });
});

describe('report file names', () => {
  it('uses the period and a slugged report kind', () => {
    expect(reportFilename('Batch performance', '2026-05-01', '2026-05-31')).toBe(
      'farmatics-batch-performance-2026-05-01-to-2026-05-31.csv',
    );
  });
});
