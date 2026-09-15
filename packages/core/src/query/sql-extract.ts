/**
 * Get the SQL out of whatever the model actually returned.
 *
 * Instructing a model to "return only SQL" reduces the problem; it does not remove it.
 * Small local models — the default tier — wrap output in markdown fences, prefix it with
 * "Sure! Here's the query:", and add a trailing explanation, all while following the rest
 * of the instruction. Being tolerant here is what makes the bundled tier usable at all,
 * and it costs nothing on a model that behaves.
 */

export interface ExtractedSql {
  readonly sql: string | null;
  /** Present when the model explicitly declined. */
  readonly cannotAnswer: string | null;
}

const FENCE = /```(?:sql)?\s*([\s\S]*?)```/i;
const DECLINE = /CANNOT_ANSWER\s*:?\s*(.*)/i;

export function extractSql(raw: string): ExtractedSql {
  const text = raw.trim();

  // The decline path is checked first and against the whole response: a model that says
  // it cannot answer and then offers a speculative query anyway must be treated as having
  // declined, not as having produced SQL (invariant §1.5 — never fabricate a value).
  const declined = DECLINE.exec(text);
  if (declined !== null) {
    const reason = (declined[1] ?? '').trim();
    return { sql: null, cannotAnswer: reason.length > 0 ? reason : 'The model did not say why.' };
  }

  const fenced = FENCE.exec(text);
  const body = (fenced?.[1] ?? text).trim();

  const statement = firstStatement(body);
  return statement === null ? { sql: null, cannotAnswer: null } : { sql: statement, cannotAnswer: null };
}

/**
 * Take the statement and drop any commentary around it.
 *
 * Note the keyword list includes writes. That is deliberate: extraction must **not**
 * quietly filter out a DELETE the model produced, because "the model tried to delete your
 * data and Datera refused" is a security-relevant event the user is entitled to see — and
 * spec §6 calls it the teaching moment. Pre-filtering here would report it as "the model
 * produced no SQL", which is both untrue and the least useful thing to say.
 *
 * So anything statement-shaped is extracted and handed to the read-only guard, which is
 * the single place allowed to decide what may run.
 */
const STATEMENT_START =
  /\b(SELECT|WITH|INSERT|UPDATE|DELETE|MERGE|CREATE|DROP|ALTER|TRUNCATE|COPY|EXPORT|ATTACH|DETACH|INSTALL|LOAD|PRAGMA|CALL|SET|BEGIN|VACUUM|EXPLAIN|DESCRIBE|SHOW|SUMMARIZE)\b/i;

function firstStatement(body: string): string | null {
  const start = STATEMENT_START.exec(body);
  if (start === null) return null;

  const from = body.slice(start.index);

  // Stop at the first semicolon: a trailing "This query groups by product." is discarded,
  // and a second statement cannot ride along behind the first. The guard would refuse a
  // batch anyway; this makes the common innocent case work instead of rejecting it.
  const semicolon = from.indexOf(';');
  const statement = (semicolon === -1 ? from : from.slice(0, semicolon)).trim();

  return statement.length > 0 ? statement : null;
}
