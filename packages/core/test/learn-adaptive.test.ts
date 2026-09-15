import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_LIFECYCLE } from '@datera/core';
import { fixturePaths, openTestWorkspace, testPorts, type FixturePaths, type TestWorkspace } from '@datera/testkit';

/**
 * Learn, grounded in the user's own data (spec §5, §11.9).
 *
 * The shipped lifecycle uses a generic `revenue` example. That teaches the concept but
 * not *your* schema — and the whole claim of the teaching module is that it makes the
 * invisible parts of working with **your** data visible. So when a suitable column exists,
 * the default lifecycle is derived from it.
 *
 * Still curated, not traced: the layers above the table are the standard ones, because
 * Datera has not read anyone's application code and must not imply that it has.
 */
describe('§11.9 the lifecycle adapts to the connected data', () => {
  let ws: TestWorkspace;
  let fixtures: FixturePaths;

  beforeEach(async () => {
    fixtures = fixturePaths(process.env['DATERA_FIXTURES'] as string);
    ws = await openTestWorkspace({ ports: testPorts() });
  });

  afterEach(async () => {
    await ws.dispose();
  });

  it('falls back to the shipped example when nothing is connected', async () => {
    const lifecycle = await ws.datera.getLifecycle();
    expect(lifecycle.label).toBe(DEFAULT_LIFECYCLE.label);
    expect(lifecycle.grounding).toBe('generic');
  });

  it('uses a real money column when one is connected', async () => {
    await ws.datera.addSource({ type: 'file', path: fixtures.ordersCsv, name: 'orders' });

    const lifecycle = await ws.datera.getLifecycle();

    expect(lifecycle.grounding).toBe('your data');
    expect(lifecycle.label).toBe('revenue_cents');
    // The table layer names the real source and the real type.
    expect(lifecycle.layers[0]?.key).toBe('orders');
    expect(lifecycle.layers[0]?.representation).toContain('revenue_cents');
    expect(lifecycle.layers[0]?.representation).toContain('BIGINT');
  });

  it('uses a real value from the data in the table layer', async () => {
    await ws.datera.addSource({ type: 'file', path: fixtures.ordersCsv, name: 'orders' });
    const lifecycle = await ws.datera.getLifecycle();

    // 8900 is genuinely in the fixture. Showing an invented number in a teaching tool
    // would undercut the one thing the tool is for.
    expect(lifecycle.layers[0]?.representation).toMatch(/\d/);
    expect(lifecycle.layers.at(-1)?.representation).toContain('89');
  });

  it('keeps the off-by-100 bug attached to the conversion that causes it', async () => {
    await ws.datera.addSource({ type: 'file', path: fixtures.ordersCsv, name: 'orders' });
    const lifecycle = await ws.datera.getLifecycle();

    const bugs = lifecycle.transforms.map((t) => t.bug ?? '').join(' ');
    expect(bugs).toMatch(/100/);
  });

  it('mentions the dictionary definition when one is confirmed', async () => {
    const [source] = await ws.datera.addSource({ type: 'file', path: fixtures.ordersCsv, name: 'orders' });
    const draft = await ws.datera.draftDictionary(source!.id);
    await ws.datera.confirmColumn(source!.id, {
      ...draft.columns.find((c) => c.column === 'revenue_cents')!,
      state: 'confirmed',
    });

    const lifecycle = await ws.datera.getLifecycle();
    const nlLane = lifecycle.lanes.find((l) => /nl/i.test(l.name));
    expect(nlLane?.note).toContain('sales');
  });

  it('falls back gracefully when the data has no money-ish column', async () => {
    await ws.datera.addSource({ type: 'file', path: fixtures.notesNdjson, name: 'notes' });
    const lifecycle = await ws.datera.getLifecycle();

    // Still grounded in real data, just a different value — no fabricated cents column.
    expect(lifecycle.layers[0]?.key).toBe('notes');
    expect(lifecycle.grounding).toBe('your data');
  });

  it('an authored lifecycle still wins over the derived one', async () => {
    await ws.datera.addSource({ type: 'file', path: fixtures.ordersCsv, name: 'orders' });
    await ws.datera.setLifecycle({
      label: 'instructor_choice',
      layers: [
        { name: 'Table', key: 't', representation: 'x' },
        { name: 'User', key: 'u', representation: 'y' },
      ],
      transforms: [{ description: 'mine', bug: null }],
      lanes: [],
    });

    const lifecycle = await ws.datera.getLifecycle();
    expect(lifecycle.label).toBe('instructor_choice');
    expect(lifecycle.grounding).toBe('authored');
  });

  it('resetting returns to the derived one, not the generic one', async () => {
    await ws.datera.addSource({ type: 'file', path: fixtures.ordersCsv, name: 'orders' });
    await ws.datera.setLifecycle({ ...DEFAULT_LIFECYCLE, label: 'temporary' });
    await ws.datera.resetLifecycle();

    const lifecycle = await ws.datera.getLifecycle();
    expect(lifecycle.grounding).toBe('your data');
    expect(lifecycle.label).toBe('revenue_cents');
  });
});
