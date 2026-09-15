import type { Route } from './trace.js';

/**
 * Structured or semantic (spec §5, acceptance §12.5).
 *
 * Decided in code from the question's shape and the dataset's, never by asking a model.
 * Routing determines what the user waits for and pays for, so making it itself a model
 * call would be both slow and circular — and §1.5 puts routing squarely in the
 * "computed, not generated" column.
 *
 * The decision is reported with its signals, because "why did my question go down the
 * vector path" is a question the glass box has to answer.
 */

export interface RouteDecision {
  readonly route: Route;
  readonly reason: string;
  /** The specific words or facts that drove it. */
  readonly signals: readonly string[];
  /**
   * True when the question looked like a meaning question but nothing is embedded.
   *
   * Routing still goes to SQL — there is nothing to search — but the caller can say so
   * if the structured attempt then fails, instead of reporting a bare "no SQL produced"
   * to someone who asked what their customers complained about.
   */
  readonly semanticUnavailable: boolean;
}

/** Words that indicate aggregation or filtering — the shape SQL is for. */
const STRUCTURED_WORDS = [
  'how many', 'count', 'total', 'sum', 'average', 'avg', 'mean', 'median',
  'top ', 'bottom ', 'most ', 'least ', 'maximum', 'minimum', 'max ', 'min ',
  'per ', 'by ', 'group', 'between', 'greater', 'less than', 'more than',
  'percentage', 'percent', 'ratio', 'trend', 'over time', 'last quarter',
  'last month', 'last year', 'this year', 'breakdown',
];

/** Words that indicate a question about the *meaning* of free text. */
const SEMANTIC_WORDS = [
  'complain', 'complaint', 'mention', 'mentioning', 'about', 'said', 'say', 'says',
  'feedback', 'sentiment', 'similar', 'like "', 'describe', 'describing',
  'talk about', 'referring', 'refers', 'discuss', 'themes', 'topics',
  'anything about', 'find notes', 'reviews',
];

export function routeQuestion(question: string, embeddedTextColumns: readonly string[]): RouteDecision {
  const q = question.toLowerCase();

  // Nothing embedded means the semantic path cannot answer, whatever the wording. This is
  // checked first because it is a fact about the data, and facts beat heuristics.
  if (embeddedTextColumns.length === 0) {
    return {
      route: 'structured',
      reason:
        'Structured → NL→SQL. This dataset has no embedded text columns, so there is nothing for a semantic search to match against.',
      signals: ['no embedded text in this dataset'],
      semanticUnavailable: SEMANTIC_WORDS.some((w) => q.includes(w)),
    };
  }

  const structuredHits = STRUCTURED_WORDS.filter((w) => q.includes(w));
  const semanticHits = SEMANTIC_WORDS.filter((w) => q.includes(w));

  // A question that quotes a phrase is asking for something *like* it.
  const quoted = /["“'].{4,}["”']/.test(question);
  if (quoted) semanticHits.push('a quoted phrase to match against');

  if (semanticHits.length > structuredHits.length) {
    return {
      route: 'semantic',
      reason:
        'Semantic → embeddings. This asks about the meaning of free text, which SQL cannot match; the question is embedded and compared against the embedded text.',
      signals: semanticHits,
      semanticUnavailable: false,
    };
  }

  return {
    route: 'structured',
    reason:
      structuredHits.length > 0
        ? 'Structured → NL→SQL over the dataset schema. No embeddings were computed.'
        : 'Structured → NL→SQL. Nothing in the question points at the meaning of free text, and SQL gives an exact, citable answer.',
    signals: structuredHits.length > 0 ? structuredHits : ['no free-text meaning signals'],
    semanticUnavailable: false,
  };
}
