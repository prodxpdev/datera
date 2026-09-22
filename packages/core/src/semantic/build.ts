import type { Engine } from '../engine/engine.js';
import type { EmbeddingModel } from '../models/embeddings.js';
import type { SourceDictionary } from '../dictionary/types.js';
import type { SourceSchema } from '../schema/introspect.js';
import { existingHashes, insertChunks, readTextColumn, type StoredChunk } from './store.js';

/**
 * Embed the text columns of a dataset (spec §5, semantic path).
 *
 * "Which columns are text" is decided from the dictionary when the user has said so, and
 * from measured value length when they have not — not from the DuckDB type, because a
 * VARCHAR holding `Pro`/`Team`/`Free` is a category and embedding it produces noise that
 * makes retrieval worse.
 */

export interface BuildResult {
  readonly chunksEmbedded: number;
  /** Chunks whose text was unchanged since the last build. */
  readonly chunksReused: number;
  readonly columns: readonly string[];
  readonly modelId: string;
}

/** Below this average length, a text column is a category, not prose. */
const MIN_AVERAGE_LENGTH = 24;
/** Rows read per column. Bounded so a first build on a large source stays finite. */
const MAX_ROWS_PER_COLUMN = 20_000;
/** Longer text is split, so one long document cannot dominate a single vector. */
const CHUNK_CHARS = 800;

export async function buildEmbeddings(options: {
  readonly engine: Engine;
  readonly model: EmbeddingModel;
  readonly datasetId: string;
  readonly schemaName: string;
  readonly schemas: readonly SourceSchema[];
  readonly dictionaries: readonly SourceDictionary[];
  readonly makeId: () => string;
  readonly hash: (text: string) => string;
}): Promise<BuildResult> {
  const dictionaryByName = new Map(options.dictionaries.map((d) => [d.sourceName, d]));

  const chunks: StoredChunk[] = [];
  const columns = new Set<string>();

  for (const schema of options.schemas) {
    const dictionary = dictionaryByName.get(schema.sourceName);
    const keyColumn = pickKeyColumn(schema, dictionary);

    for (const column of schema.columns) {
      if (!isTextColumn(column, dictionary)) continue;

      // A column the user marked sensitive is not embedded. Embedding it would put its
      // content into a store that a later retrieval could send to a model (§4).
      const definition = dictionary?.columns.find((c) => c.column === column.name);
      if (definition?.sensitivity === 'hidden') continue;

      columns.add(column.name);

      const rows = await readTextColumn(
        options.engine, options.schemaName, schema.sourceName, column.name, keyColumn, MAX_ROWS_PER_COLUMN,
      );

      for (const row of rows) {
        for (const [index, text] of splitText(row.text).entries()) {
          chunks.push({
            id: options.makeId(),
            datasetId: options.datasetId,
            sourceName: schema.sourceName,
            column: column.name,
            rowKey: index === 0 ? row.rowKey : `${row.rowKey}#${index}`,
            text,
            textHash: options.hash(`${schema.sourceName}:${column.name}:${row.rowKey}:${index}:${text}`),
          });
        }
      }
    }
  }

  const modelId = options.model.descriptor.id;
  const already = await existingHashes(options.engine, options.datasetId, modelId);
  const pending = chunks.filter((c) => !already.has(c.textHash));

  if (pending.length > 0) {
    const vectors = await options.model.embed(pending.map((c) => c.text));
    await insertChunks(options.engine, pending, vectors, modelId);
  }

  return {
    chunksEmbedded: pending.length,
    chunksReused: chunks.length - pending.length,
    columns: [...columns],
    modelId,
  };
}

function isTextColumn(
  column: SourceSchema['columns'][number],
  dictionary: SourceDictionary | undefined,
): boolean {
  const definition = dictionary?.columns.find((c) => c.column === column.name);

  // A confirmed role is the user's decision and beats any measurement.
  if (definition?.state === 'confirmed') return definition.role === 'text';

  if (!column.type.toUpperCase().startsWith('VARCHAR')) return false;
  if (column.sampleValues.length === 0) return false;

  const average = column.sampleValues.reduce((n, s) => n + s.length, 0) / column.sampleValues.length;
  return average >= MIN_AVERAGE_LENGTH;
}

function pickKeyColumn(schema: SourceSchema, dictionary: SourceDictionary | undefined): string | null {
  const declared = dictionary?.entity.primaryKey;
  if (declared !== undefined && declared.length > 0) return declared;

  const idish = schema.columns.find((c) => /(^|_)id$/i.test(c.name) || c.type.toUpperCase() === 'UUID');
  return idish?.name ?? null;
}

/** Split on paragraph boundaries where possible, so chunks stay readable when cited. */
function splitText(text: string): readonly string[] {
  if (text.length <= CHUNK_CHARS) return [text];

  const parts: string[] = [];
  let remaining = text;
  while (remaining.length > CHUNK_CHARS) {
    const window = remaining.slice(0, CHUNK_CHARS);
    const cut = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('. '), window.lastIndexOf(' '));
    const at = cut > CHUNK_CHARS / 2 ? cut : CHUNK_CHARS;
    parts.push(remaining.slice(0, at).trim());
    remaining = remaining.slice(at).trim();
  }
  if (remaining.length > 0) parts.push(remaining);
  return parts;
}
