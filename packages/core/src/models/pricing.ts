import { FREE, type Pricing } from './types.js';

/**
 * Published list prices, USD per million tokens.
 *
 * Deliberately a lookup with an explicit unknown case rather than a default: inventing a
 * price for a model we do not know about would put a confident wrong number on the cost
 * line, and the cost line is one of the things the user is being invited to trust.
 * Unknown pricing reports as unknown.
 */
const TABLE: Readonly<Record<string, Pricing>> = {
  'claude-opus-4-1': { inputPerMillionUsd: 15, outputPerMillionUsd: 75 },
  'claude-sonnet-4-5': { inputPerMillionUsd: 3, outputPerMillionUsd: 15 },
  'claude-haiku-4-5': { inputPerMillionUsd: 1, outputPerMillionUsd: 5 },
  'gpt-4o': { inputPerMillionUsd: 2.5, outputPerMillionUsd: 10 },
  'gpt-4o-mini': { inputPerMillionUsd: 0.15, outputPerMillionUsd: 0.6 },
};

export function pricingFor(provider: string, modelId: string, locality: 'local' | 'remote'): Pricing | null {
  // Anything running on this machine costs nothing to call, and that zero is a fact.
  if (locality === 'local') return FREE;

  const exact = TABLE[modelId];
  if (exact !== undefined) return exact;

  // Providers version their ids (claude-sonnet-4-5-20260101). Match the longest prefix.
  const prefix = Object.keys(TABLE)
    .filter((key) => modelId.startsWith(key))
    .sort((a, b) => b.length - a.length)[0];

  if (prefix !== undefined) return TABLE[prefix] ?? null;

  void provider;
  return null;
}
