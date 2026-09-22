import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_LIFECYCLE } from '@datera/core';
import { openTestWorkspace, testPorts, type TestWorkspace } from '@datera/testkit';

/**
 * Phase 9 — the data-lifecycle view (spec §5, §11.9).
 *
 * Curated or instructor-defined for v1. The acceptance that matters is that a teacher can
 * author one **without a code change**, and that every boundary carries its classic bug —
 * a lifecycle diagram without the bugs is a diagram, not a lesson.
 *
 * Live tracing of a user's real application code is explicitly out of scope for v1, and
 * one test pins that so it does not drift in by accident.
 */
describe('§11.9 the lifecycle view', () => {
  let ws: TestWorkspace;

  beforeEach(async () => {
    ws = await openTestWorkspace({ ports: testPorts() });
  });

  afterEach(async () => {
    await ws.dispose();
  });

  it('ships a default lifecycle out of the box', async () => {
    const lifecycle = await ws.datera.getLifecycle();

    expect(lifecycle.label).toBeTruthy();
    expect(lifecycle.layers.length).toBeGreaterThanOrEqual(5);
    expect(lifecycle.layers[0]?.name).toMatch(/table/i);
  });

  it('follows one value from the table to the screen', async () => {
    const lifecycle = await ws.datera.getLifecycle();
    const names = lifecycle.layers.map((l) => l.name.toLowerCase()).join(' ');

    expect(names).toContain('table');
    expect(names).toContain('dto');
    expect(names).toContain('user');
  });

  it('carries the classic money bug at the boundary where it happens', async () => {
    const lifecycle = await ws.datera.getLifecycle();
    const bugs = lifecycle.transforms.map((t) => t.bug ?? '').join(' ');

    // The canonical example from the spec's own teaching section.
    expect(bugs).toMatch(/off-by-100|÷100|cents/i);
  });

  it('has one transform between each pair of layers — no gaps', async () => {
    const lifecycle = await ws.datera.getLifecycle();
    expect(lifecycle.transforms).toHaveLength(lifecycle.layers.length - 1);
  });

  it('shows the NL, semantic and MCP lanes', async () => {
    const lifecycle = await ws.datera.getLifecycle();
    const lanes = lifecycle.lanes.map((l) => l.name.toLowerCase()).join(' ');

    expect(lanes).toContain('nl');
    expect(lanes).toContain('semantic');
    expect(lanes).toContain('mcp');
  });

  it('is authorable without a code change', async () => {
    // The acceptance criterion: an instructor defines their own and it takes effect.
    await ws.datera.setLifecycle({
      label: 'order_status',
      layers: [
        { name: 'Table', key: 'orders', representation: "status VARCHAR = 'P'" },
        { name: 'Entity', key: 'OrderEntity', representation: "status: Status.PENDING" },
        { name: 'User', key: 'sees', representation: '"Pending"' },
      ],
      transforms: [
        { description: 'ORM maps the code to an enum', bug: 'an unknown code throws at load' },
        { description: 'localised for display', bug: 'the enum name leaks to the user when unmapped' },
      ],
      lanes: [{ name: 'NL', note: 'the dictionary defines what P means' }],
    });

    const stored = await ws.datera.getLifecycle();
    expect(stored.label).toBe('order_status');
    expect(stored.layers).toHaveLength(3);
    expect(stored.transforms[0]?.bug).toContain('throws');
  });

  it('survives a restart', async () => {
    await ws.datera.setLifecycle({
      ...DEFAULT_LIFECYCLE,
      label: 'custom_value',
    });

    ws = await ws.reopen();
    expect((await ws.datera.getLifecycle()).label).toBe('custom_value');
  });

  it('rejects a definition whose transforms do not line up with its layers', async () => {
    // A lifecycle with a missing transform renders a boundary with no explanation, which
    // is precisely the part a student needs.
    await expect(
      ws.datera.setLifecycle({
        label: 'broken',
        layers: [
          { name: 'A', key: 'a', representation: '1' },
          { name: 'B', key: 'b', representation: '2' },
          { name: 'C', key: 'c', representation: '3' },
        ],
        transforms: [{ description: 'only one', bug: null }],
        lanes: [],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('rejects a definition with fewer than two layers', async () => {
    await expect(
      ws.datera.setLifecycle({
        label: 'x',
        layers: [{ name: 'A', key: 'a', representation: '1' }],
        transforms: [],
        lanes: [],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('can be reset to the shipped default', async () => {
    await ws.datera.setLifecycle({ ...DEFAULT_LIFECYCLE, label: 'temporary' });
    await ws.datera.resetLifecycle();

    expect((await ws.datera.getLifecycle()).label).toBe(DEFAULT_LIFECYCLE.label);
  });

  it('is curated, not traced from real application code (v1 scope)', async () => {
    const lifecycle = await ws.datera.getLifecycle();

    // §5 scopes v1 to curated/instructor-defined. This asserts the shape stays declarative:
    // no file paths, no source locations, nothing that implies Datera read someone's code.
    expect(lifecycle.source).toBe('curated');
    expect(JSON.stringify(lifecycle)).not.toMatch(/"file"|"lineNumber"|"stackFrame"/);
  });
});
