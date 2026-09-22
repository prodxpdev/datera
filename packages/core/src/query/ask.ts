import { DateraError } from '../errors.js';
import type { Engine } from '../engine/engine.js';
import { assertReadOnlySql } from '../engine/read-only.js';
import { assertWithinDataset } from './scope.js';
import { describeModel, type ChatModel } from '../models/types.js';
import { timeoutForModel } from '../models/latency.js';
import type { SourceSchema } from '../schema/introspect.js';
import type { SourceDictionary } from '../dictionary/types.js';
import type { AuthoredRelationship } from '../datasets/authoring.js';
import { buildSchemaContext, buildUserPrompt, summariseSchemas, SYSTEM_PROMPT } from './context.js';
import { extractSql } from './sql-extract.js';
import { TraceBuilder, type Route, type Trace } from './trace.js';
import { routeQuestion } from './router.js';
import type { EmbeddingModel } from '../models/embeddings.js';
import type { SearchHit } from '../semantic/store.js';

export interface AskResult {
  readonly question: string;
  readonly datasetId: string;
  /** Null when Datera declined to answer. */
  readonly sql: string | null;
  readonly columns: readonly { name: string; type: string }[];
  readonly rows: readonly (readonly unknown[])[];
  readonly citations: Citations;
  /** False when no honest answer was available. Never "answered anyway". */
  readonly answerable: boolean;
  /** Present when something needs saying — why it declined, or why the result is empty. */
  readonly flag: string | null;
  readonly trace: Trace;
}

export interface Citations {
  /** Sources the query read. */
  readonly sources: readonly string[];
  /** Columns named in the query. */
  readonly columns: readonly string[];
  /** Rows actually returned — counted in code, never reported by the model. */
  readonly rowCount: number;
}

export interface AskOptions {
  readonly engine: Engine;
  readonly model: ChatModel | null;
  readonly datasetId: string;
  readonly datasetName: string;
  readonly schemaName: string;
  /** Schema name → dataset name, so a refusal can say which dataset was reached for. */
  readonly schemaToDataset: ReadonlyMap<string, string>;
  readonly schemas: readonly SourceSchema[];
  /** Confirmed definitions only — filtering happens in buildSchemaContext (§1.3). */
  readonly dictionaries?: readonly SourceDictionary[] | undefined;
  readonly relationships?: readonly AuthoredRelationship[] | undefined;
  /** Null when no embedding model is configured — the semantic path is then unavailable. */
  readonly embeddingModel?: EmbeddingModel | null | undefined;
  /** Columns that actually have vectors stored. Drives routing (§12.5). */
  readonly embeddedColumns?: readonly string[] | undefined;
  /** Retrieval, injected so `ask` never reaches the store directly. */
  readonly search?: ((vector: readonly number[], k: number) => Promise<readonly SearchHit[]>) | undefined;
  readonly topK?: number | undefined;
  readonly question: string;
  readonly traceId: string;
  readonly now: () => Date;
  readonly monotonicMs: () => number;
  readonly maxRows?: number | undefined;
}

const DEFAULT_MAX_ROWS = 1_000;

/**
 * Answer a question about a dataset, and record exactly how (spec §5).
 *
 * The shape of this function is the point. Every step is a trace stage, the model is
 * consulted for exactly one thing — writing SQL — and every fact in the result is
 * computed here from what the engine returned, never taken from the model's prose
 * (invariant §1.5).
 *
 * Three ways this refuses to answer, all of them deliberate:
 *  - the model declines (CANNOT_ANSWER);
 *  - the model produces SQL that will not bind, which almost always means an invented
 *    column — the characteristic failure of a small local model;
 *  - the SQL is not read-only, which includes an NL instruction that turned into a DELETE.
 *
 * In each case the answer is a flag. Not a guess, and not an empty success.
 */
export async function ask(options: AskOptions): Promise<AskResult> {
  const trace = new TraceBuilder(
    options.traceId,
    options.datasetId,
    options.question,
    options.now().toISOString(),
    options.monotonicMs,
  );

  const decline = (flag: string, declineRoute: Route = 'structured'): AskResult => ({
    question: options.question,
    datasetId: options.datasetId,
    sql: null,
    columns: [],
    rows: [],
    citations: { sources: [], columns: [], rowCount: 0 },
    answerable: false,
    flag,
    trace: trace.build(declineRoute, false),
  });

  // ---- parse -------------------------------------------------------------
  const question = options.question.trim();
  if (question.length === 0) {
    throw new DateraError('INVALID_ARGUMENT', 'Ask a question.');
  }
  trace.add({
    kind: 'parse',
    label: 'Question',
    detail: `${question.length} characters. Taken verbatim; Datera does not rewrite your question.`,
  });

  // ---- route -------------------------------------------------------------
  // Computed from the question and the dataset's shape, in code (§1.5, §12.5).
  const decision = routeQuestion(question, options.embeddedColumns ?? []);
  const route: Route = decision.route;
  trace.add({
    kind: 'route',
    label: 'Routing',
    route,
    detail: `${decision.reason} Signals: ${decision.signals.join(', ')}.`,
  });

  if (options.model === null) {
    throw new DateraError(
      'MODEL_UNAVAILABLE',
      'No chat model is configured. Choose one in Models — a local runtime such as Ollama, or your own API key.',
      { datasetId: options.datasetId },
    );
  }

  if (options.schemas.length === 0) {
    return decline('This dataset has no sources, so there is nothing to query.', route);
  }

  if (route === 'semantic') {
    return answerSemantically(options, trace, question, decline);
  }

  // ---- schema ------------------------------------------------------------
  const contextOptions = {
    dictionaries: options.dictionaries,
    relationships: options.relationships,
  };
  const schemaContext = buildSchemaContext(options.schemas, contextOptions);
  trace.add({
    kind: 'schema',
    label: 'Schema and definitions given to the model',
    schemaSummary: summariseSchemas(options.schemas, contextOptions),
    detail: schemaContext,
  });

  // ---- model -------------------------------------------------------------
  const userPrompt = buildUserPrompt(question, schemaContext);
  const payload = `${SYSTEM_PROMPT}\n\n---\n\n${userPrompt}`;

  const response = await options.model.chat({
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0,
    // Local models get minutes, remote ones a minute (#33). A flat ceiling turned a slow
    // weight load into a failure, which then read as "local models do not work".
    timeoutMs: timeoutForModel(options.model.descriptor),
  });

  trace.add({
    kind: 'model',
    label: 'Sent to model',
    model: response.model,
    modelName: describeModel(response.model),
    modelPayload: payload,
    inputTokens: response.usage.inputTokens,
    outputTokens: response.usage.outputTokens,
    costUsd: response.usage.costUsd,
    detail:
      `Schema only — your data stayed local. ` +
      `${response.usage.inputTokens} in / ${response.usage.outputTokens} out` +
      (response.usage.costUsd === 0 ? ' · $0 (runs on this machine)' : ` · $${response.usage.costUsd.toFixed(4)}`),
  });

  // ---- sql ---------------------------------------------------------------
  const extracted = extractSql(response.text);

  if (extracted.cannotAnswer !== null) {
    trace.add({ kind: 'sql', label: 'No SQL generated', detail: extracted.cannotAnswer });
    return decline(
      `Datera could not answer this from the connected data: ${extracted.cannotAnswer}` +
        (decision.semanticUnavailable
          ? ' If you meant to search free text by meaning, build embeddings for this dataset first.'
          : ''),
      route,
    );
  }

  if (extracted.sql === null) {
    trace.add({
      kind: 'sql',
      label: 'No SQL generated',
      detail: `The model returned no usable statement: ${response.text.slice(0, 200)}`,
    });
    return decline(
      'The model did not produce a SQL statement. Try rephrasing, or pick a stronger model — small local models struggle with vague questions.' +
        (decision.semanticUnavailable
          ? ' This looks like a question about the meaning of free text: build embeddings for this dataset and Datera can search it by meaning instead.'
          : ''),
      route,
    );
  }

  const sql = extracted.sql;
  trace.add({ kind: 'sql', label: 'Generated SQL', sql, detail: 'Shown before it runs.' });

  // ---- guard -------------------------------------------------------------
  // The same guard that protects the SQL editor. A model is not trusted more than a user.
  await options.engine.executeInternal(`SET search_path = "${options.schemaName.replace(/"/g, '""')}"`);

  try {
    await assertReadOnlySql(engineConnection(options.engine), sql);
  } catch (e) {
    if (DateraError.is(e, 'READ_ONLY_VIOLATION')) {
      trace.add({ kind: 'guard', label: 'Refused', detail: e.message });
      return decline(
        `Refused: the model produced a statement that would modify data, and Datera is read-only. ${e.message}`,
      );
    }
    throw e;
  }

  // The dataset boundary applies to generated SQL exactly as it does to hand-written SQL.
  // A model is not trusted more than a user — and a model that has only been shown one
  // dataset's schema should never produce this, which makes it worth refusing loudly.
  try {
    await assertWithinDataset(
      engineConnection(options.engine),
      sql,
      options.schemaName,
      options.datasetName,
      options.schemaToDataset,
    );
  } catch (e) {
    if (DateraError.is(e, 'CROSS_DATASET_ACCESS')) {
      trace.add({ kind: 'guard', label: 'Refused — dataset boundary', detail: e.message });
      return decline(`Refused: ${e.message}`);
    }
    throw e;
  }

  trace.add({
    kind: 'guard',
    label: 'Read-only check',
    detail: 'Passed — a single read-only SELECT within this dataset, verified by DuckDB’s parser before running.',
  });

  // ---- execute -----------------------------------------------------------
  let result;
  try {
    result = await options.engine.executeUserQuery(sql, options.monotonicMs);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    trace.add({ kind: 'execute', label: 'Failed', detail: message });

    // A binder or catalog error here overwhelmingly means an invented column. Reporting
    // it as "cannot answer" rather than as a crash is the honest framing: the question
    // was not answerable from this data, whatever the model asserted.
    return decline(
      `Datera could not answer this: the generated SQL referred to something that does not exist in your data. ${message}`,
    );
  }

  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
  const rows = result.resultSet.rows.slice(0, maxRows);

  trace.add({
    kind: 'execute',
    label: 'Ran locally (read-only)',
    rowCount: rows.length,
    detail: `DuckDB · ${result.durationMs.toFixed(0)}ms · ${rows.length} row${rows.length === 1 ? '' : 's'}`,
  });

  const citations: Citations = {
    sources: options.schemas.map((s) => s.sourceName).filter((name) => mentions(sql, name)),
    columns: options.schemas
      .flatMap((s) => s.columns.map((c) => c.name))
      .filter((name, i, all) => all.indexOf(name) === i && mentions(sql, name)),
    rowCount: rows.length,
  };

  const flag =
    rows.length === 0
      ? 'The query ran and matched no rows. That is not the same as a zero — check the filters in the SQL above.'
      : null;

  return {
    question,
    datasetId: options.datasetId,
    sql,
    columns: result.resultSet.columns.map((c) => ({ name: c.name, type: c.type })),
    rows,
    citations,
    answerable: true,
    flag,
    trace: trace.build(route, true),
  };
}

/** Whole-word match, so `qty` does not "appear in" `quantity`. */
function mentions(sql: string, identifier: string): boolean {
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\w"])"?${escaped}"?($|[^\\w"])`, 'i').test(sql);
}

/**
 * The guard needs a connection to classify against; the engine owns the only one.
 *
 * Exposed through a narrow accessor rather than handing the pipeline the connection,
 * so `ask` cannot execute anything except through `executeUserQuery`.
 */
function engineConnection(engine: Engine): Parameters<typeof assertReadOnlySql>[0] {
  return engine.classificationConnection();
}


/**
 * The semantic path (spec §5).
 *
 * Embed the question, retrieve the closest chunks, and send **only those chunks** to the
 * model — never the corpus. That is the whole point of retrieval: the model sees a handful
 * of records instead of everything, which is both what makes it affordable and what keeps
 * the exposure bounded.
 *
 * Note the asymmetry with the structured path, which is worth being clear-eyed about: the
 * structured path sends schema only, while this one necessarily sends *actual text*. The
 * user is told so in the trace rather than left to infer it.
 */
async function answerSemantically(
  options: AskOptions,
  trace: TraceBuilder,
  question: string,
  decline: (flag: string, route?: Route) => AskResult,
): Promise<AskResult> {
  const embedder = options.embeddingModel ?? null;
  const search = options.search;

  if (embedder === null || search === undefined) {
    return decline(
      'This question is about the meaning of free text, but no embedding model is configured. Choose one in Models — a local embedder keeps the text on this machine.',
      'semantic',
    );
  }

  if ((options.embeddedColumns ?? []).length === 0) {
    return decline(
      'Nothing has been embedded in this dataset yet. Build embeddings first, and the text columns become searchable by meaning.',
      'semantic',
    );
  }

  // ---- embed the question ------------------------------------------------
  const [queryVector] = await embedder.embed([question]);
  if (queryVector === undefined) {
    return decline('The embedding model returned no vector for the question.', 'semantic');
  }

  trace.add({
    kind: 'embed',
    label: 'Question embedded',
    model: embedder.descriptor,
    modelName: describeModel(embedder.descriptor),
    detail: `The question became a ${queryVector.length}-dimension vector. Your text was embedded ${embedder.descriptor.locality === 'local' ? 'on this machine' : 'by a remote provider'}.`,
  });

  // ---- retrieve ----------------------------------------------------------
  const k = Math.max(1, Math.trunc(options.topK ?? 5));
  const hits = await search(queryVector, k);

  if (hits.length === 0) {
    trace.add({ kind: 'retrieve', label: 'Nothing matched', detail: 'No embedded chunk was similar enough.' });
    return decline('Nothing in the embedded text was close enough to this question to answer it.', 'semantic');
  }

  trace.add({
    kind: 'retrieve',
    label: 'Closest matches',
    rowCount: hits.length,
    detail: hits
      .map((h) => `${h.source}#${h.rowKey} (${h.score.toFixed(3)})`)
      .join(', '),
  });

  // ---- model -------------------------------------------------------------
  const context = hits
    .map((h, i) => `[${i + 1}] ${h.source}#${h.rowKey} — ${h.text}`)
    .join('\n\n');

  const system = [
    'You answer questions using only the excerpts provided.',
    'Cite the excerpt numbers you used, like [1].',
    'If the excerpts do not answer the question, say so plainly. Never invent details.',
  ].join('\n');
  const user = `Excerpts:\n\n${context}\n\nQuestion: ${question}`;

  const response = await options.model!.chat({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0,
  });

  trace.add({
    kind: 'model',
    label: 'Sent to model',
    model: response.model,
    modelName: describeModel(response.model),
    modelPayload: `${system}\n\n---\n\n${user}`,
    inputTokens: response.usage.inputTokens,
    outputTokens: response.usage.outputTokens,
    costUsd: response.usage.costUsd,
    detail:
      `Only the ${hits.length} closest excerpt${hits.length === 1 ? '' : 's'} went to the model — not the whole corpus. ` +
      `Unlike the structured path, this necessarily includes real text from your data.`,
  });

  return {
    question,
    datasetId: options.datasetId,
    sql: null,
    columns: [
      { name: 'match', type: 'VARCHAR' },
      { name: 'score', type: 'DOUBLE' },
      { name: 'text', type: 'VARCHAR' },
    ],
    rows: hits.map((h) => [`${h.source}#${h.rowKey}`, h.score, h.text]),
    citations: {
      sources: [...new Set(hits.map((h) => h.source))],
      columns: [...new Set(hits.map((h) => h.column))],
      rowCount: hits.length,
    },
    answerable: true,
    flag: response.text.trim().length > 0 ? response.text.trim() : null,
    trace: trace.build('semantic', true),
  };
}
