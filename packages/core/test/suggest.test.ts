import { describe, expect, it } from 'vitest';
import { suggestQuestions, type SchemaGraph } from '@datera/core';

/**
 * Starter questions, derived — not generated.
 *
 * Someone who has never written a query does not know what their data can answer, and an
 * empty box with a blinking cursor teaches them nothing. The suggestions are built from
 * the schema by rule, so they cost nothing, work with no key configured, and can never
 * propose a column that is not there.
 */
const graph: SchemaGraph = {
  datasetId: 'd',
  tables: [
    {
      name: 'orders',
      rowCount: 1200,
      hiddenColumns: 0,
      columns: [
        { name: 'order_id', type: 'VARCHAR', isKey: true, nullCount: 0, meaning: '' },
        { name: 'region', type: 'VARCHAR', isKey: false, nullCount: 0, meaning: '' },
        { name: 'ordered_at', type: 'DATE', isKey: false, nullCount: 0, meaning: '' },
        { name: 'revenue_cents', type: 'BIGINT', isKey: false, nullCount: 0, meaning: 'Money in minor units' },
      ],
    },
    {
      name: 'support_notes',
      rowCount: 90,
      hiddenColumns: 0,
      columns: [
        { name: 'order_id', type: 'VARCHAR', isKey: true, nullCount: 0, meaning: '' },
        { name: 'note', type: 'VARCHAR', isKey: false, nullCount: 0, meaning: '' },
      ],
    },
  ],
  relationships: [
    { fromTable: 'support_notes', fromColumn: 'order_id', toTable: 'orders', toColumn: 'order_id' },
  ],
};

describe('suggested questions', () => {
  it('suggests how many rows each table has', () => {
    const labels = suggestQuestions(graph).map((s) => s.question);
    expect(labels.some((q) => /how many/i.test(q) && q.includes('orders'))).toBe(true);
  });

  it('suggests a measure grouped by a dimension', () => {
    const match = suggestQuestions(graph).find(
      (s) => s.question.includes('revenue_cents') && s.question.includes('region'),
    );
    expect(match).toBeDefined();
  });

  it('suggests a trend when there is a date column', () => {
    expect(suggestQuestions(graph).some((s) => /month|over time/i.test(s.question))).toBe(true);
  });

  it('suggests a join only where a relationship was confirmed', () => {
    const joined = suggestQuestions(graph).find((s) => s.kind === 'join');
    expect(joined?.question).toMatch(/orders/);
    expect(joined?.question).toMatch(/support_notes/);

    const noLinks = suggestQuestions({ ...graph, relationships: [] });
    expect(noLinks.some((s) => s.kind === 'join')).toBe(false);
  });

  it('says which columns each suggestion would use, so it teaches rather than just works', () => {
    for (const suggestion of suggestQuestions(graph)) {
      expect(suggestion.because.length).toBeGreaterThan(0);
    }
  });

  it('prefers the confirmed meaning when explaining a column', () => {
    const revenue = suggestQuestions(graph).find((s) => s.question.includes('revenue_cents'));
    expect(revenue?.because).toContain('Money in minor units');
  });

  it('suggests nothing for an empty dataset, rather than something generic', () => {
    expect(suggestQuestions({ datasetId: 'd', tables: [], relationships: [] })).toEqual([]);
  });

  it('never names a hidden column', () => {
    // schemaGraph() has already removed them; this asserts the suggester adds none back.
    const hiddenOnly: SchemaGraph = {
      datasetId: 'd',
      tables: [{ name: 't', rowCount: 5, hiddenColumns: 3, columns: [] }],
      relationships: [],
    };
    const all = suggestQuestions(hiddenOnly).map((s) => s.question).join(' ');
    expect(all).not.toMatch(/undefined|null/);
  });

  it('is deterministic and bounded', () => {
    const a = suggestQuestions(graph);
    expect(a).toEqual(suggestQuestions(graph));
    expect(a.length).toBeLessThanOrEqual(6);
  });
});
