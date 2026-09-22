import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_DATASET_ID } from '@datera/core';
import {
  fixturePaths,
  openTestWorkspace,
  startStubModelServer,
  testPorts,
  type FixturePaths,
  type StubModelServer,
  type TestWorkspace,
} from '@datera/testkit';

/**
 * Phase 3 — the dictionary (spec §4) and relationships (spec §3).
 *
 * Two invariants are on trial here. §1.3, the model proposes and a human confirms: nothing
 * auto-drafted may take effect until somebody says so. And §1.5, deterministic where facts
 * matter: the draft is computed from column names, types and observed values in code — it
 * is a *proposal*, not a model's opinion, and it is reproducible.
 */
describe('§4 dictionary', () => {
  let ws: TestWorkspace;
  let fixtures: FixturePaths;
  let sourceId: string;

  beforeEach(async () => {
    fixtures = fixturePaths(process.env['DATERA_FIXTURES'] as string);
    ws = await openTestWorkspace({ ports: testPorts({ http: true }) });
    const [source] = await ws.datera.addSource({ type: 'file', path: fixtures.ordersCsv, name: 'orders' });
    sourceId = source!.id;
  });

  afterEach(async () => {
    await ws.dispose();
  });

  describe('auto-draft proposes, and nothing is confirmed', () => {
    it('drafts an entry for every column, all marked suggested', async () => {
      const draft = await ws.datera.draftDictionary(sourceId);

      expect(draft.columns.map((c) => c.column)).toEqual([
        'order_id', 'product', 'revenue_cents', 'qty', 'created_at', 'refunded',
      ]);
      // §1.3 — a draft is a proposal. Nothing arrives confirmed.
      expect(draft.columns.every((c) => c.state === 'suggested')).toBe(true);
      expect(draft.entity.state).toBe('suggested');
    });

    it('infers roles from names and types', async () => {
      const draft = await ws.datera.draftDictionary(sourceId);
      const role = (name: string): string | undefined => draft.columns.find((c) => c.column === name)?.role;

      expect(role('order_id')).toBe('id');
      expect(role('revenue_cents')).toBe('measure');
      expect(role('created_at')).toBe('time');
      expect(role('refunded')).toBe('flag');
      expect(role('product')).toBe('dimension');
    });

    it('recognises minor-unit money columns and proposes the conversion', async () => {
      // The single most valuable thing the dictionary does: without it, "what were my
      // sales" returns a number 100× too large and looks entirely plausible.
      const draft = await ws.datera.draftDictionary(sourceId);
      const revenue = draft.columns.find((c) => c.column === 'revenue_cents');

      expect(revenue?.unit).toMatch(/cents/i);
      expect(revenue?.unit).toContain('100');
      expect(revenue?.aliases).toEqual(expect.arrayContaining(['revenue']));
    });

    it('proposes aliases a person would actually say', async () => {
      const draft = await ws.datera.draftDictionary(sourceId);
      const aliases = draft.columns.find((c) => c.column === 'revenue_cents')?.aliases ?? [];
      expect(aliases).toEqual(expect.arrayContaining(['sales']));
    });

    it('proposes enum meanings for a small value set', async () => {
      const draft = await ws.datera.draftDictionary(sourceId);
      const refunded = draft.columns.find((c) => c.column === 'refunded');
      expect(refunded?.enumValues?.map((e) => e.value).sort()).toEqual(['false', 'true']);
    });

    it('proposes a primary key from observed uniqueness, not from the name alone', async () => {
      const draft = await ws.datera.draftDictionary(sourceId);
      // order_id is unique across all six rows; product is not.
      expect(draft.entity.primaryKey).toBe('order_id');
    });

    it('is deterministic — the same source drafts identically twice', async () => {
      const a = await ws.datera.draftDictionary(sourceId);
      const b = await ws.datera.draftDictionary(sourceId);
      expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    });

    it('drafting alone changes nothing that is stored', async () => {
      await ws.datera.draftDictionary(sourceId);
      const stored = await ws.datera.getDictionary(sourceId);
      expect(stored.columns.every((c) => c.state === 'undefined')).toBe(true);
    });
  });

  describe('confirming (invariant §1.3)', () => {
    it('stores a confirmed entry, and leaves the rest alone', async () => {
      const draft = await ws.datera.draftDictionary(sourceId);
      const revenue = draft.columns.find((c) => c.column === 'revenue_cents')!;

      await ws.datera.confirmColumn(sourceId, { ...revenue, state: 'confirmed' });

      const stored = await ws.datera.getDictionary(sourceId);
      expect(stored.columns.find((c) => c.column === 'revenue_cents')?.state).toBe('confirmed');
      expect(stored.columns.find((c) => c.column === 'product')?.state).toBe('undefined');
    });

    it('lets a human edit the proposal before confirming it', async () => {
      const draft = await ws.datera.draftDictionary(sourceId);
      const revenue = draft.columns.find((c) => c.column === 'revenue_cents')!;

      await ws.datera.confirmColumn(sourceId, {
        ...revenue,
        meaning: 'Net revenue after discounts, in cents.',
        aliases: ['sales', 'takings'],
        state: 'confirmed',
      });

      const stored = await ws.datera.getDictionary(sourceId);
      const saved = stored.columns.find((c) => c.column === 'revenue_cents');
      expect(saved?.meaning).toContain('after discounts');
      expect(saved?.aliases).toEqual(['sales', 'takings']);
    });

    it('survives a restart', async () => {
      const draft = await ws.datera.draftDictionary(sourceId);
      await ws.datera.confirmColumn(sourceId, { ...draft.columns[0]!, state: 'confirmed' });
      await ws.datera.confirmEntity(sourceId, { ...draft.entity, state: 'confirmed' });

      ws = await ws.reopen();

      const stored = await ws.datera.getDictionary(sourceId);
      expect(stored.columns[0]?.state).toBe('confirmed');
      expect(stored.entity.state).toBe('confirmed');
    });
  });

  describe('the payoff — the dictionary changes the SQL (§12 Epic 3)', () => {
    let server: StubModelServer;

    beforeEach(async () => {
      server = await startStubModelServer();
      await ws.datera.setChatModel({
        tier: 'detected', provider: 'ollama', id: 'llama3.1:8b', role: 'chat',
        locality: 'local', endpoint: server.url, label: 'llama3.1:8b',
      });
    });

    afterEach(async () => {
      await server.close();
    });

    it('sends confirmed definitions to the model', async () => {
      const draft = await ws.datera.draftDictionary(sourceId);
      const revenue = draft.columns.find((c) => c.column === 'revenue_cents')!;
      await ws.datera.confirmColumn(sourceId, { ...revenue, state: 'confirmed' });

      server.setReply('SELECT sum(revenue_cents)/100.0 FROM orders');
      await ws.datera.ask(DEFAULT_DATASET_ID, 'what were my sales?');

      const sent = JSON.stringify(server.requests.at(-1)?.json ?? {});
      expect(sent).toContain('sales');
      expect(sent).toMatch(/cents/i);
      // Still no data values, dictionary or not.
      expect(sent).not.toContain('Trail Hoodie');
    });

    it('does not send unconfirmed drafts — a suggestion is not a fact', async () => {
      // Drafting without confirming must not change the model's context, or "propose then
      // confirm" would be theatre.
      await ws.datera.draftDictionary(sourceId);

      server.setReply('SELECT 1');
      await ws.datera.ask(DEFAULT_DATASET_ID, 'anything');

      const sent = JSON.stringify(server.requests.at(-1)?.json ?? {});
      expect(sent).not.toContain('sales');
    });

    it('shows the injected definitions in the trace', async () => {
      const draft = await ws.datera.draftDictionary(sourceId);
      await ws.datera.confirmColumn(
        sourceId,
        { ...draft.columns.find((c) => c.column === 'revenue_cents')!, state: 'confirmed' },
      );

      server.setReply('SELECT 1');
      const answer = await ws.datera.ask(DEFAULT_DATASET_ID, 'anything');

      const schemaStage = answer.trace.stages.find((s) => s.kind === 'schema');
      expect(schemaStage?.detail).toMatch(/sales/);
      expect(schemaStage?.schemaSummary).toMatch(/definition/i);
    });

    it('hides a column marked sensitive from the model entirely', async () => {
      // §4 sensitivity: "hide-from-NL". A column the user has marked sensitive must not
      // appear in the payload at all — not its values, not even its name.
      const draft = await ws.datera.draftDictionary(sourceId);
      const product = draft.columns.find((c) => c.column === 'product')!;
      await ws.datera.confirmColumn(sourceId, { ...product, sensitivity: 'hidden', state: 'confirmed' });

      server.setReply('SELECT 1');
      await ws.datera.ask(DEFAULT_DATASET_ID, 'anything');

      const sent = JSON.stringify(server.requests.at(-1)?.json ?? {});
      expect(sent).not.toContain('product');
      expect(sent).toContain('revenue_cents');
    });
  });
});

describe('§3 relationships', () => {
  let ws: TestWorkspace;
  let fixtures: FixturePaths;

  beforeEach(async () => {
    fixtures = fixturePaths(process.env['DATERA_FIXTURES'] as string);
    // http: true because one test below asks a question; without it the core gets
    // OfflineHttp and refuses to reach even a local stub, which is the intended default.
    ws = await openTestWorkspace({ ports: testPorts({ http: true }) });
    await ws.datera.addSource({ type: 'file', path: fixtures.ordersCsv, name: 'orders' });
    await ws.datera.addSource({ type: 'file', path: fixtures.notesNdjson, name: 'support_notes' });
  });

  afterEach(async () => {
    await ws.dispose();
  });

  it('detects a shared key and proposes it, unconfirmed', async () => {
    const found = await ws.datera.detectRelationships(DEFAULT_DATASET_ID);

    const link = found.find((r) => r.fromColumn === 'order_id' && r.toColumn === 'order_id');
    expect(link).toBeDefined();
    // §1.3 — detected, not applied.
    expect(link?.state).toBe('suggested');
  });

  it('explains why it thinks so, in terms a person can check', async () => {
    const [link] = await ws.datera.detectRelationships(DEFAULT_DATASET_ID);
    expect(link?.evidence).toMatch(/same name/i);
    expect(link?.evidence).toMatch(/\d+ of \d+|%/);
  });

  it('reports the overlap it measured, rather than asserting a match', async () => {
    const [link] = await ws.datera.detectRelationships(DEFAULT_DATASET_ID);
    // Two of the three fixture notes reference an order that exists.
    expect(link?.matchRatio).toBeGreaterThan(0);
    expect(link?.matchRatio).toBeLessThanOrEqual(1);
  });

  it('does not propose a link between columns whose values never overlap', async () => {
    const found = await ws.datera.detectRelationships(DEFAULT_DATASET_ID);
    expect(found.some((r) => r.fromColumn === 'product' || r.toColumn === 'note')).toBe(false);
  });

  it('detection alone stores nothing', async () => {
    await ws.datera.detectRelationships(DEFAULT_DATASET_ID);
    expect(await ws.datera.listRelationships(DEFAULT_DATASET_ID)).toEqual([]);
  });

  it('confirming stores it, and it survives a restart', async () => {
    const [link] = await ws.datera.detectRelationships(DEFAULT_DATASET_ID);
    await ws.datera.confirmRelationship(DEFAULT_DATASET_ID, link!);

    ws = await ws.reopen();

    const stored = await ws.datera.listRelationships(DEFAULT_DATASET_ID);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.state).toBe('confirmed');
  });

  it('tells the model about confirmed relationships, so it can join', async () => {
    const server = await startStubModelServer();
    try {
      const [link] = await ws.datera.detectRelationships(DEFAULT_DATASET_ID);
      await ws.datera.confirmRelationship(DEFAULT_DATASET_ID, link!);
      await ws.datera.setChatModel({
        tier: 'detected', provider: 'ollama', id: 'llama3.1:8b', role: 'chat',
        locality: 'local', endpoint: server.url, label: 'llama3.1:8b',
      });

      server.setReply('SELECT 1');
      await ws.datera.ask(DEFAULT_DATASET_ID, 'anything');

      const sent = JSON.stringify(server.requests.at(-1)?.json ?? {});
      expect(sent).toMatch(/support_notes\.order_id/);
    } finally {
      await server.close();
    }
  });
});
