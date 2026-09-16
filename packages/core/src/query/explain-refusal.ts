/**
 * Duck-typed rather than `instanceof DateraError`, deliberately: the desktop renderer
 * receives errors across contextBridge, which strips the prototype and rebuilds them as a
 * different class. An explanation that only worked inside the core process would be
 * missing from the one place a learner actually sees the refusal.
 */
interface RefusalLike {
  readonly code: string;
  readonly details?: Readonly<Record<string, unknown>> | undefined;
}

function asRefusal(error: unknown): RefusalLike | null {
  if (typeof error !== 'object' || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? (error as RefusalLike) : null;
}

/**
 * Why a query was refused, in terms of what it would have done.
 *
 * "READ_ONLY_VIOLATION. Refused: DELETE." names the rule that fired. That is accurate and
 * teaches nothing. Someone who is still learning what a database *is* needs the
 * consequence — this would have removed rows, permanently, from the file it read — and
 * the honest alternative.
 *
 * A refusal is the best teaching moment the product gets: it lands at the exact instant
 * someone tried the dangerous thing, which is the one moment they are certain to be
 * paying attention. Spending it on an error code is a waste.
 */
export interface RefusalExplanation {
  readonly whatItWouldHaveDone: string;
  readonly whatToDoInstead: string;
}

const CONSEQUENCES: Record<string, string> = {
  DELETE: 'removed rows permanently — DELETE takes rows out and leaves no copy behind.',
  UPDATE: 'changed values in place, overwriting what was there with no record of the old values.',
  INSERT: 'added new rows to the table.',
  DROP: 'removed an entire table, not just its rows — the structure would have gone too.',
  ALTER: 'changed the structure of a table: its columns, their types or their constraints.',
  CREATE: 'created new objects in the database.',
  TRUNCATE: 'emptied a table completely, in one statement, with no row-by-row record.',
};

export function explainRefusal(error: unknown): RefusalExplanation | null {
  const refusal = asRefusal(error);
  if (refusal === null) return null;

  const details = (refusal.details ?? {}) as {
    offending?: unknown;
    statementCount?: unknown;
    activeDataset?: unknown;
  };

  if (refusal.code === 'CROSS_DATASET_ACCESS') {
    const named = Array.isArray(details.offending) ? details.offending.join(', ') : 'another dataset';
    return {
      whatItWouldHaveDone: `read ${named}, which is outside the dataset you are querying. A dataset is a boundary: Datera guarantees that sources in different datasets are never joined, so a number can never be quietly assembled from two things that were never meant to meet.`,
      whatToDoInstead: 'If those sources genuinely belong together, move them into the same dataset in Data — then the join is something you decided, not something a query did by accident.',
    };
  }

  if (refusal.code === 'WRITE_NOT_PERMITTED') {
    return {
      whatItWouldHaveDone: 'change rows in this dataset. Writes are off by default on every dataset, so nothing — not you, not an agent calling the API — can modify data until someone deliberately turns them on.',
      whatToDoInstead: 'Enable writes on this dataset in Data → Write access. That does not apply anything on its own: every change is still previewed with its exact row count and old → new values, and confirmed by you.',
    };
  }

  if (refusal.code !== 'READ_ONLY_VIOLATION') return null;

  if (typeof details.statementCount === 'number' && details.statementCount > 1) {
    return {
      whatItWouldHaveDone: 'run more than one statement at once. Datera refuses batches because a second statement can hide behind an innocuous first one, and because one question should produce one answer you can trace.',
      whatToDoInstead: 'Run the statements one at a time, so each has its own result and its own record in the log.',
    };
  }

  const offending = Array.isArray(details.offending)
    ? details.offending.map((k) => String(k).toUpperCase())
    : [];

  const known = offending.filter((k) => k in CONSEQUENCES);

  if (known.length === 0) {
    return {
      whatItWouldHaveDone: offending.length > 0
        // Named but unrecognised: say it changes things, and do not invent a consequence
        // for a statement whose effect this code does not actually know.
        ? `run ${offending.join(', ')}, which changes the database rather than reading it.`
        : 'change the database rather than read it. Datera could not prove this statement was a read, so it refused — failing closed is the only safe direction for a guard like this.',
      whatToDoInstead: 'Rewrite it as a SELECT if you only wanted to look. To actually change data, derive a working copy in Data and use Changes, where every edit is previewed and confirmed first.',
    };
  }

  return {
    whatItWouldHaveDone: `have ${known.map((k) => CONSEQUENCES[k]).join(' It would also have ')}`,
    whatToDoInstead: 'Datera never writes to a source you connected, so this cannot be allowed here at all. Derive a working copy in Data, then use Changes — there the same statement is previewed with its exact row count and old → new values before anything happens, and can be undone.',
  };
}
