import { describe, expect, it } from 'vitest';
import { DateraError, explainRefusal } from '@datera/core';

/**
 * Why a query was refused, in terms of what it would have done.
 *
 * "READ_ONLY_VIOLATION. Refused: DELETE." is accurate and teaches nothing — it names the
 * rule that fired. Someone learning what a database *is* needs the consequence: this
 * would have removed rows, permanently, from the thing it read.
 *
 * The refusal is the single best teaching moment the product has. It happens at the exact
 * instant someone tried the dangerous thing, which is the one moment they are guaranteed
 * to be paying attention.
 */
describe('explaining a refusal', () => {
  it('says what a DELETE would have done, not just that it was refused', () => {
    const refusal = new DateraError('READ_ONLY_VIOLATION', 'Datera is read-only. Refused: DELETE.', {
      sql: 'DELETE FROM orders', statementKinds: ['DELETE'], offending: ['DELETE'],
    });

    const explained = explainRefusal(refusal);
    expect(explained?.whatItWouldHaveDone).toMatch(/remove|delete/i);
    expect(explained?.whatItWouldHaveDone).toMatch(/row/i);
    expect(explained?.whatToDoInstead).toMatch(/working copy|Changes|derive/i);
  });

  it('distinguishes UPDATE from DELETE, because the consequences differ', () => {
    const update = explainRefusal(
      new DateraError('READ_ONLY_VIOLATION', 'x', { offending: ['UPDATE'] }),
    );
    expect(update?.whatItWouldHaveDone).toMatch(/change|overwrite|replace/i);
    expect(update?.whatItWouldHaveDone).not.toMatch(/remove the rows/i);
  });

  it('explains a dropped table as losing the table itself, not rows', () => {
    const dropped = explainRefusal(
      new DateraError('READ_ONLY_VIOLATION', 'x', { offending: ['DROP'] }),
    );
    expect(dropped?.whatItWouldHaveDone).toMatch(/table/i);
  });

  it('explains a batch as a second statement hiding behind the first', () => {
    const batch = explainRefusal(
      new DateraError('READ_ONLY_VIOLATION', 'Refused a multi-statement batch; run one at a time.', {
        statementCount: 2,
      }),
    );
    expect(batch?.whatItWouldHaveDone).toMatch(/more than one|second statement/i);
  });

  it('explains a cross-dataset refusal as the boundary doing its job', () => {
    const crossed = explainRefusal(
      new DateraError('CROSS_DATASET_ACCESS', 'This query reaches outside "Sales": other.t', {
        activeDataset: 'Sales', offending: ['other.t'],
      }),
    );
    expect(crossed?.whatItWouldHaveDone).toMatch(/outside|another dataset/i);
    expect(crossed?.whatToDoInstead).toMatch(/same dataset|move/i);
  });

  it('returns nothing for an error that is not a refusal', () => {
    expect(explainRefusal(new DateraError('INVALID_ARGUMENT', 'Empty SQL statement'))).toBeNull();
    expect(explainRefusal(new Error('boom'))).toBeNull();
  });

  it('never invents a consequence for a statement kind it does not know', () => {
    const odd = explainRefusal(
      new DateraError('READ_ONLY_VIOLATION', 'x', { offending: ['VACUUM'] }),
    );
    // Still explained — as "changes the database" — but without claiming to know rows
    // were at stake, because it does not.
    expect(odd?.whatItWouldHaveDone).toMatch(/change/i);
    expect(odd?.whatItWouldHaveDone).not.toMatch(/\d+ rows/);
  });
});
