import { DateraError } from '../errors.js';

/**
 * The data-lifecycle teaching module (spec §5, §11.9).
 *
 * "A value isn't just a table cell — it transforms at every layer." This follows one
 * value from the table to the screen, and at each boundary names both the transform and
 * the **classic bug** that happens there. The bugs are the lesson: a lifecycle diagram
 * without them is a diagram.
 *
 * Curated or instructor-defined for v1. Live tracing of a user's real application code is
 * a later phase, which is why nothing in this shape refers to a file or a line number —
 * the structure itself declines to imply Datera read anyone's code.
 */

export interface LifecycleLayer {
  /** e.g. 'Table', 'Entity (ORM)', 'DTO'. */
  readonly name: string;
  /** Where it lives — 'orders', 'OrderEntity', 'API'. */
  readonly key: string;
  /** How the value looks here. Plain text; the UI highlights it. */
  readonly representation: string;
}

export interface LifecycleTransform {
  readonly description: string;
  /** The classic bug at this boundary. Null when there genuinely is not one. */
  readonly bug: string | null;
}

export interface LifecycleLane {
  readonly name: string;
  readonly note: string;
}

export interface Lifecycle {
  /** The value being followed — 'revenue'. */
  readonly label: string;
  readonly layers: readonly LifecycleLayer[];
  /** Exactly one per boundary: layers.length - 1. */
  readonly transforms: readonly LifecycleTransform[];
  readonly lanes: readonly LifecycleLane[];
  /** Always 'curated' in v1. Present so the later traced variant is distinguishable. */
  readonly source?: 'curated';
  /**
   * Where the example came from.
   *
   * 'your data' — derived from a connected column, so the names and the value are real.
   * 'authored' — an instructor wrote it.
   * 'generic'  — the shipped example, used when nothing is connected yet.
   *
   * Shown in the UI, because "this is your data" and "this is an illustration" are
   * different claims and a teaching tool should not blur them.
   */
  readonly grounding?: 'your data' | 'authored' | 'generic';
}

/**
 * The shipped default: money in minor units, and the off-by-100 that follows it.
 *
 * Chosen because it is the bug the spec itself names, it is genuinely common, and it is
 * the same one Datera's dictionary exists to prevent — so a student meets it twice, once
 * as a lesson and once as a feature.
 */
export const DEFAULT_LIFECYCLE: Lifecycle = {
  label: 'revenue',
  source: 'curated',
  layers: [
    { name: 'Table', key: 'orders', representation: 'revenue_cents BIGINT = 8900' },
    { name: 'Entity (ORM)', key: 'OrderEntity', representation: 'revenueCents: 8900' },
    { name: 'Business object', key: 'domain', representation: 'revenue: Money(89.00, "USD")' },
    { name: 'DTO', key: 'API', representation: '"revenue": { "amount": "89.00", "currency": "USD" }' },
    { name: 'View', key: 'UI', representation: 'price: "$89.00"' },
    { name: 'User', key: 'sees', representation: '$89.00' },
  ],
  transforms: [
    {
      description: 'The ORM maps column to field, BIGINT to Int. The name still says cents.',
      bug: null,
    },
    {
      description: 'Cents become dollars and gain a currency: Money(amount, currency).',
      bug: 'The classic off-by-100. Divide by 100 here or forget to, and every total is wrong by two orders of magnitude while still looking plausible.',
    },
    {
      description: 'Serialised as a string amount plus a currency code.',
      bug: 'Never serialise money as a float — 89.00 is not exactly representable, and the error compounds on the way back.',
    },
    {
      description: 'Formatted for the viewer’s locale.',
      bug: 'A hard-coded "$" is correct until the first user outside the United States.',
    },
    { description: 'Rendered.', bug: null },
  ],
  lanes: [
    {
      name: 'NL → SQL',
      note: 'The dictionary tells the model that revenue_cents is minor units and is also called "sales", so "what were my sales" becomes SUM(revenue_cents)/100 — the same division, made explicit.',
    },
    {
      name: 'Semantic',
      note: 'A number never takes this lane. Only text is embedded, which is why a CSV of amounts is not a vector search problem.',
    },
    {
      name: 'MCP',
      note: 'An agent reads through the same guards as the UI — read-only, dataset-scoped — and gets the same rows, with a trace of everything it did.',
    },
  ],
};

export function validateLifecycle(lifecycle: Lifecycle): void {
  if (lifecycle.label.trim().length === 0) {
    throw new DateraError('INVALID_ARGUMENT', 'A lifecycle needs a label — the value being followed.', {});
  }

  if (lifecycle.layers.length < 2) {
    throw new DateraError(
      'INVALID_ARGUMENT',
      'A lifecycle needs at least two layers; the point is the boundary between them.',
      { layers: lifecycle.layers.length },
    );
  }

  // One transform per boundary, exactly. A missing one renders a boundary with no
  // explanation, which is the part a student most needs.
  if (lifecycle.transforms.length !== lifecycle.layers.length - 1) {
    throw new DateraError(
      'INVALID_ARGUMENT',
      `A lifecycle with ${lifecycle.layers.length} layers needs exactly ${lifecycle.layers.length - 1} ` +
        `transforms, one per boundary — got ${lifecycle.transforms.length}.`,
      { layers: lifecycle.layers.length, transforms: lifecycle.transforms.length },
    );
  }
}
