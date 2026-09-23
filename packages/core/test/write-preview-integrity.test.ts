import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_DATASET_ID } from '@datera/core';
import {
  fixturePaths, openTestWorkspace, testPorts,
  type FixturePaths, type TestWorkspace,
} from '@datera/testkit';

/**
 * The preview describes the statement that will run.
 *
 * This is the load-bearing control of the whole write path: §6 says the model proposes and
 * a human confirms, and the human confirms on the strength of what the preview says. A
 * preview that can be made to disagree with the statement does not merely mislead — it
 * converts the confirm gate into a rubber stamp.
 *
 * It could be. The preview reconstructed its count and sample queries by slicing the
 * statement text with a regex, and that text contains attacker-controlled string literals.
 * A value of "WHERE 1=0 --" put a WHERE clause inside a literal, the slicer found it before
 * the real one, and all three preview queries became valid SQL that matched nothing — so a
 * full-table overwrite rendered as "This matches no rows. Confirming it would change
 * nothing." Reachable from the agent-facing propose_write tool.
 *
 * The fix is not better escaping — the executed statement was always escaped correctly.
 * It is that the slicer now knows where a literal starts and ends.
 */
describe('a write preview cannot be made to lie', () => {
  let ws: TestWorkspace;
  let fixtures: FixturePaths;
  let dataset: string;

  beforeEach(async () => {
    fixtures = fixturePaths(process.env['DATERA_FIXTURES'] as string);
    ws = await openTestWorkspace({ ports: testPorts() });
    await ws.datera.addSource({ type: 'file', path: fixtures.ordersCsv, name: 'orders' });
    // A working copy, because a connected source can never be granted writes.
    dataset = (await ws.datera.deriveDataset(DEFAULT_DATASET_ID, { name: 'Working copy' })).datasetId;
    await ws.datera.grantWrite(dataset);
  });

  afterEach(async () => {
    await ws.dispose();
  });

  it('counts every row a WHERE hidden inside a literal would touch', async () => {
    const proposal = await ws.datera.proposeWrite(
      dataset,
      `UPDATE orders SET product = 'WHERE 1=0 --'`,
    );

    // The statement has no WHERE at all, so it affects every row — and the preview has to
    // say so rather than reading the literal as a predicate.
    expect(proposal.warnings.join(' ')).toMatch(/no WHERE clause|every row/i);
    expect(proposal.warnings.join(' ')).not.toMatch(/matches no rows/i);
  });

  it('does not mistake a literal containing SET for an assignment list', async () => {
    const proposal = await ws.datera.proposeWrite(
      dataset,
      `UPDATE orders SET product = 'SET product = 1, qty = 2' WHERE qty = 1`,
    );
    expect(proposal.sql).toContain('UPDATE');
  });

  it('survives ordinary data that happens to contain commas and parentheses', async () => {
    // The same root cause in the other direction: a value with a comma in it used to split
    // the assignment list into garbage, so "Smith, John" broke the proposal outright.
    const proposal = await ws.datera.proposeWrite(
      dataset,
      `UPDATE orders SET product = 'Smith, John (see item (3))' WHERE qty = 1`,
    );
    expect(proposal.sql).toContain('Smith, John');
  });

  it('refuses a cross-dataset write however the name is quoted', async () => {
    for (const target of ['ds_other.customers', 'ds_other."customers"', '"ds_other"."customers"']) {
      await expect(
        ws.datera.proposeWrite(dataset, `UPDATE ${target} SET a = 1`),
      ).rejects.toThrow();
    }
  });

  it('does not refuse a write because a value contains a dot', async () => {
    // The inverse of the same bug: the guard scanned inside literals, so an email address
    // or a hostname in a value tripped a false cross-dataset refusal.
    const proposal = await ws.datera.proposeWrite(
      dataset,
      `UPDATE orders SET product = 'acme.com' WHERE qty = 1`,
    );
    expect(proposal.sql).toContain('acme.com');
  });
});
