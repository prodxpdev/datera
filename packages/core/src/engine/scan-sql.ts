/**
 * Walk a SQL statement while knowing what is code and what is data.
 *
 * Several things need to find a keyword, a comma or a qualified name *in the statement* —
 * the write preview needs the WHERE clause, the cross-dataset guard needs the schema names
 * — and a plain regex cannot tell `WHERE` the clause from `'WHERE'` the string a user
 * typed. That difference was exploitable: a value of `WHERE 1=0 --` made the preview
 * report a full-table UPDATE as matching no rows, which turns the confirm gate into a
 * rubber stamp.
 *
 * This is not a parser. It is the smallest thing that reliably answers "is this offset
 * inside a literal, an identifier or a comment?", which is all those callers need. The
 * statement has already been classified by DuckDB's own parser before it reaches here.
 */

/** A region of the statement that is data or commentary, never syntax. */
interface Span {
  readonly start: number;
  readonly end: number;
}

/**
 * Every span of `sql` that is a string literal, a quoted identifier or a comment.
 *
 * Handles the four things DuckDB actually accepts: `'…'` with `''` escaping, `"…"` with
 * `""` escaping, `$tag$…$tag$` dollar quoting, and `--` / `/* … *\/` comments.
 */
export function maskedSpans(sql: string): readonly Span[] {
  const spans: Span[] = [];
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i];

    if (ch === "'" || ch === '"') {
      const quote = ch;
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === quote) {
          // A doubled quote is an escaped one and the literal continues.
          if (sql[j + 1] === quote) { j += 2; continue; }
          j += 1;
          break;
        }
        j += 1;
      }
      spans.push({ start: i, end: j });
      i = j;
      continue;
    }

    if (ch === '$') {
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
      if (tag !== null) {
        const marker = tag[0];
        const close = sql.indexOf(marker, i + marker.length);
        const end = close === -1 ? sql.length : close + marker.length;
        spans.push({ start: i, end });
        i = end;
        continue;
      }
    }

    if (ch === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      const end = nl === -1 ? sql.length : nl;
      spans.push({ start: i, end });
      i = end;
      continue;
    }

    if (ch === '/' && sql[i + 1] === '*') {
      const close = sql.indexOf('*/', i + 2);
      const end = close === -1 ? sql.length : close + 2;
      spans.push({ start: i, end });
      i = end;
      continue;
    }

    i += 1;
  }

  return spans;
}

/**
 * The statement with every literal, quoted identifier and comment blanked to spaces.
 *
 * Offsets are preserved exactly, so a match found in the mask can be sliced out of the
 * original. That is what makes this safe to use with the regexes that were already here:
 * they keep working, they simply can no longer see into a string.
 */
export function maskLiterals(sql: string): string {
  const chars = [...sql];
  for (const span of maskedSpans(sql)) {
    for (let i = span.start; i < span.end && i < chars.length; i += 1) {
      // Newlines are kept so that line-based reasoning and error offsets still line up.
      if (chars[i] !== '\n') chars[i] = ' ';
    }
  }
  return chars.join('');
}

/** Whether `index` falls inside a literal, quoted identifier or comment. */
export function isMasked(sql: string, index: number): boolean {
  return maskedSpans(sql).some((s) => index >= s.start && index < s.end);
}

/**
 * Like `maskLiterals`, but quoted identifiers survive.
 *
 * The cross-dataset guard has to see `"ds_other"."customers"` — blanking the identifier
 * would hide exactly the thing it is looking for — while still being blind to a schema-like
 * string inside a value. So string literals and comments are blanked and `"…"` is kept.
 */
export function maskIdentifiersKept(sql: string): string {
  const chars = [...sql];
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i];

    if (ch === '"') {
      // Skipped over, not blanked.
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') { j += 2; continue; }
          j += 1;
          break;
        }
        j += 1;
      }
      i = j;
      continue;
    }

    if (ch === "'" || ch === '$' || (ch === '-' && sql[i + 1] === '-') || (ch === '/' && sql[i + 1] === '*')) {
      const span = maskedSpans(sql.slice(i))[0];
      if (span !== undefined && span.start === 0) {
        for (let k = i; k < i + span.end && k < chars.length; k += 1) {
          if (chars[k] !== '\n') chars[k] = ' ';
        }
        i += span.end;
        continue;
      }
    }

    i += 1;
  }

  return chars.join('');
}
