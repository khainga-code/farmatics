/**
 * Splits a SQL file into individual statements.
 *
 * Needed because the postgres driver cannot reliably send a multi-statement
 * string, and a naive `split(';')` breaks on the dollar-quoted function bodies
 * in our migrations. This tracks quotes, dollar quotes and comments.
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let buffer = '';
  let i = 0;
  const length = sql.length;

  while (i < length) {
    const char = sql[i]!;

    // -- line comment
    if (char === '-' && sql[i + 1] === '-') {
      const newline = sql.indexOf('\n', i);
      const end = newline === -1 ? length : newline;
      buffer += sql.slice(i, end);
      i = end;
      continue;
    }

    // /* block comment */
    if (char === '/' && sql[i + 1] === '*') {
      const close = sql.indexOf('*/', i + 2);
      const end = close === -1 ? length : close + 2;
      buffer += sql.slice(i, end);
      i = end;
      continue;
    }

    // 'single quoted' with '' escapes
    if (char === "'") {
      let j = i + 1;
      while (j < length) {
        if (sql[j] === "'" && sql[j + 1] === "'") {
          j += 2;
          continue;
        }
        if (sql[j] === "'") {
          j += 1;
          break;
        }
        j += 1;
      }
      buffer += sql.slice(i, j);
      i = j;
      continue;
    }

    // "double quoted" identifier
    if (char === '"') {
      let j = i + 1;
      while (j < length) {
        if (sql[j] === '"' && sql[j + 1] === '"') {
          j += 2;
          continue;
        }
        if (sql[j] === '"') {
          j += 1;
          break;
        }
        j += 1;
      }
      buffer += sql.slice(i, j);
      i = j;
      continue;
    }

    // $tag$ dollar quoted body $tag$
    if (char === '$') {
      const match = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(i));
      if (match) {
        const tag = match[0];
        const close = sql.indexOf(tag, i + tag.length);
        const end = close === -1 ? length : close + tag.length;
        buffer += sql.slice(i, end);
        i = end;
        continue;
      }
    }

    if (char === ';') {
      const statement = buffer.trim();
      if (statement) statements.push(statement);
      buffer = '';
      i += 1;
      continue;
    }

    buffer += char;
    i += 1;
  }

  const tail = buffer.trim();
  if (tail) statements.push(tail);

  return statements;
}
