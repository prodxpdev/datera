import { DateraError } from './errors.js';
import { Engine } from './engine/engine.js';
import { assertExtensionLoaded } from './engine/extensions.js';
import { assertReadOnlySql } from './engine/read-only.js';
import { qualified, quoteIdent, slugifyIdent } from './engine/sql.js';
import type { DuckDBDriverPort, ResultSet, StatementKind } from './ports/duckdb.js';
import type { Ports } from './ports/index.js';
import { Catalog } from './workspace/catalog.js';
import {
  openOrCreateWorkspace,
  type WorkspaceManifest,
  type WorkspacePaths,
} from './workspace/workspace.js';
import {
  createAuthoredTable,
  assertAuthorableName,
  type AuthoredRelationship,
  type AuthoredTable,
} from './datasets/authoring.js';
import {
  DEFAULT_DATASET_DESCRIPTION,
  DEFAULT_DATASET_ID,
  DEFAULT_DATASET_NAME,
  DEFAULT_DATASET_SCHEMA,
  type Dataset,
} from './datasets/types.js';
import {
  attachDatabase,
  defaultPort,
  listAttachedTables,
  listAttachedViews,
  redactedOrigin,
  type DatabaseConnectionParams,
} from './sources/attachments.js';
import { inferFileKind, planFileRead } from './sources/files.js';
import {
  isFileSourceKind,
  type AddDatabaseSourceRequest,
  type AddFileSourceRequest,
  type AddSourceRequest,
  type AddSqliteSourceRequest,
  type Source,
  type SourceWithStatus,
} from './sources/types.js';
import { introspectSource, introspectRelation, type SourceSchema } from './schema/introspect.js';
import { ask, type AskResult } from './query/ask.js';
import { assertWithinDataset } from './query/scope.js';
import { summariseTouched, type TouchedSummary } from './query/touched.js';
import { buildEmbeddings as runBuildEmbeddings, type BuildResult } from './semantic/build.js';
import {
  countEmbedded, embeddedColumns, migrateEmbeddings, searchVectors, type SearchHit,
} from './semantic/store.js';
import {
  OpenAICompatibleEmbeddingModel, looksLikeEmbeddingModel, type EmbeddingModel,
} from './models/embeddings.js';
import { draftDictionary } from './dictionary/draft.js';
import {
  UNDEFINED_ENTITY,
  type ColumnDefinition,
  type EntityDefinition,
  type SourceDictionary,
} from './dictionary/types.js';
import {
  detectRelationships as detectRelationshipsIn,
  type RelationshipProposal,
} from './datasets/detect-relationships.js';
import { detectLocalRuntimes, type DetectedRuntime } from './models/detect.js';
import { AnthropicChatModel } from './models/anthropic.js';
import { OpenAICompatibleChatModel } from './models/openai-compatible.js';
import { describeModel, type ChatModel, type ModelDescriptor } from './models/types.js';
import { OfflineHttp, type HttpPort } from './ports/http.js';
import { stem } from './util/paths.js';

export interface DateraOptions {
  /** Directory holding workspace.json and workspace.duckdb. Created if absent. */
  readonly workspacePath: string;
  readonly driver: DuckDBDriverPort;
  readonly ports: Ports;
  /** Directory of pre-staged DuckDB extensions. See engine/extensions.ts. */
  readonly extensionDirectory?: string | undefined;
  readonly appVersion?: string | undefined;
  /** Injectable so tests get deterministic ids. */
  readonly makeId?: (() => string) | undefined;
}

export interface EngineInfo {
  readonly duckdbVersion: string;
  readonly driver: string;
  readonly extensions: readonly { name: string; loaded: boolean }[];
  readonly workspace: WorkspaceManifest;
  readonly workspacePath: string;
}

export interface PreviewOptions {
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

export interface PreviewResult {
  readonly sourceId: string;
  readonly columns: readonly { name: string; type: string }[];
  readonly rows: readonly (readonly unknown[])[];
  readonly limit: number;
  readonly offset: number;
  readonly hasMore: boolean;
}

export interface QueryResult {
  readonly datasetId: string;
  readonly sql: string;
  readonly statementKinds: readonly (StatementKind | 'UNKNOWN')[];
  readonly columns: readonly { name: string; type: string }[];
  readonly rows: readonly (readonly unknown[])[];
  readonly durationMs: number;
}

/** Where the chosen chat model is remembered between launches. */
const CHAT_MODEL_SETTING = 'model.chat';
const EMBEDDING_MODEL_SETTING = 'model.embedding';
/** Keychain entry holding the API key for a remote provider. One per provider. */
export const apiKeySecretName = (provider: string): string => `model.apiKey.${provider}`;

export interface ModelCatalogue {
  /** Runtimes found on this machine right now. Empty is a normal result, not an error. */
  readonly detected: readonly DetectedRuntime[];
  /** Remote providers the user has a stored key for. */
  readonly remote: readonly ModelDescriptor[];
  /** The chat model currently selected, if any. */
  readonly selected: ModelDescriptor | null;
  /** Rendered exactly as the trace will show it (spec §9). */
  readonly selectedName: string | null;
  /**
   * The embedding model, selected separately and never implied by the chat choice
   * (invariant §1.6). Null means the semantic path is unavailable.
   */
  readonly selectedEmbedding: ModelDescriptor | null;
  readonly selectedEmbeddingName: string | null;
  /** Detected models that look like embedders, offered for the embedding slot. */
  readonly embeddingCandidates: readonly ModelDescriptor[];
}

/** Bounded so a preview of a billion-row Parquet cannot be turned into a full scan. */
const MAX_PREVIEW_LIMIT = 1000;
const DEFAULT_PREVIEW_LIMIT = 50;

/**
 * The single public surface of the core (spec §1.7).
 *
 * Hosts — the Electron app today, `datera-server` and the `datera` CLI later — talk to
 * this and nothing else. Nothing here knows what a window, an HTTP request, or a token is.
 */
export class Datera {
  private constructor(
    private readonly engine: Engine,
    private readonly catalog: Catalog,
    private readonly ports: Ports,
    private readonly paths: WorkspacePaths,
    private readonly manifest: WorkspaceManifest,
    private readonly makeId: () => string,
    private readonly http: HttpPort,
  ) {}

  static async open(options: DateraOptions): Promise<Datera> {
    const makeId = options.makeId ?? (() => crypto.randomUUID());
    const appVersion = options.appVersion ?? '0.1.0';

    const { paths, manifest } = await openOrCreateWorkspace(
      options.ports.fs,
      options.workspacePath,
      makeId,
      () => options.ports.clock.now(),
      appVersion,
    );

    const engine = await Engine.open({
      driver: options.driver,
      logger: options.ports.logger,
      databasePath: paths.databasePath,
      extensionDirectory: options.extensionDirectory,
    });

    const catalog = new Catalog(engine);
    await catalog.migrate();
    await migrateEmbeddings(engine);

    const datera = new Datera(
      engine,
      catalog,
      options.ports,
      paths,
      manifest,
      makeId,
      // No network unless the host supplies a way to reach it: the default posture is
      // local-only, and reaching out is a deliberate act by the host (invariant §1.6).
      options.ports.http ?? new OfflineHttp(),
    );
    await datera.ensureDefaultDataset();
    await datera.reattachDatabases();
    return datera;
  }

  engineInfo(): EngineInfo {
    return {
      duckdbVersion: this.engine.duckdbVersion,
      driver: this.engine.driverName,
      extensions: this.engine.extensions.map((e) => ({ name: e.name, loaded: e.loaded })),
      workspace: this.manifest,
      workspacePath: this.paths.root,
    };
  }

  // ---------------------------------------------------------------- datasets

  async listDatasets(): Promise<readonly Dataset[]> {
    return this.catalog.listDatasets();
  }

  async getDataset(id: string): Promise<Dataset> {
    const dataset = (await this.catalog.listDatasets()).find((d) => d.id === id);
    if (dataset === undefined) {
      throw new DateraError('DATASET_NOT_FOUND', `No dataset with id "${id}"`, { datasetId: id });
    }
    return dataset;
  }

  private async defaultDataset(): Promise<Dataset> {
    const datasets = await this.catalog.listDatasets();
    const found = datasets.find((d) => d.isDefault) ?? datasets[0];
    if (found === undefined) {
      throw new DateraError('DATASET_NOT_FOUND', 'The workspace has no datasets', {});
    }
    return found;
  }

  private async ensureDefaultDataset(): Promise<void> {
    const datasets = await this.catalog.listDatasets();
    if (datasets.length > 0) return;

    const dataset: Dataset = {
      id: DEFAULT_DATASET_ID,
      name: DEFAULT_DATASET_NAME,
      description: DEFAULT_DATASET_DESCRIPTION,
      schemaName: DEFAULT_DATASET_SCHEMA,
      isDefault: true,
      createdAt: this.ports.clock.now().toISOString(),
    };
    await this.engine.executeInternal(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(dataset.schemaName)}`);
    await this.catalog.insertDataset(dataset);
  }

  // ----------------------------------------------------------------- sources

  /**
   * Sources with their current availability.
   *
   * Availability is checked, not assumed: a file that has been moved or a database that
   * is no longer reachable reports `unavailable` with a reason, rather than throwing
   * somewhere further in when a query touches it.
   */
  async listSources(): Promise<readonly SourceWithStatus[]> {
    const sources = await this.catalog.listSources();
    const out: SourceWithStatus[] = [];

    for (const source of sources) {
      out.push({ ...source, status: await this.sourceStatus(source) });
    }
    return out;
  }

  async getSource(id: string): Promise<SourceWithStatus> {
    const found = (await this.listSources()).find((s) => s.id === id);
    if (found === undefined) {
      throw new DateraError('SOURCE_NOT_FOUND', `No source with id "${id}"`, { sourceId: id });
    }
    return found;
  }

  private async sourceStatus(source: Source): Promise<SourceWithStatus['status']> {
    if (isFileSourceKind(source.kind) || source.kind === 'sqlite') {
      const path = source.kind === 'sqlite' ? source.origin : source.origin;
      if (!(await this.ports.fs.exists(path))) {
        return { availability: 'unavailable', reason: `The file is no longer at ${path}` };
      }
    }
    try {
      const dataset = await this.getDataset(source.datasetId);
      await this.engine.executeInternal(
        `SELECT 1 FROM ${qualified(dataset.schemaName, source.name)} LIMIT 0`,
      );
      return { availability: 'available' };
    } catch (e) {
      return {
        availability: 'unavailable',
        reason: e instanceof Error ? e.message : String(e),
      };
    }
  }

  /** Connect a source read-only. Returns every source created (a database yields many). */
  async addSource(request: AddSourceRequest): Promise<readonly Source[]> {
    switch (request.type) {
      case 'file':
        return [await this.addFileSource(request)];
      case 'sqlite':
        return this.addSqliteSource(request);
      case 'postgres':
      case 'mysql':
        return this.addDatabaseSource(request);
    }
  }

  private async addFileSource(request: AddFileSourceRequest): Promise<Source> {
    const dataset = request.datasetId === undefined
      ? await this.defaultDataset()
      : await this.getDataset(request.datasetId);

    // Format first, existence second: an unsupported extension is a precise, actionable
    // error that does not depend on the file being there, and reporting "no file at
    // /x.docx" for a format we would refuse anyway sends the user looking for the wrong
    // problem.
    const kind = request.kind ?? inferFileKind(request.path);

    if (!(await this.ports.fs.exists(request.path))) {
      throw new DateraError('SOURCE_UNAVAILABLE', `No file at ${request.path}`, {
        path: request.path,
      });
    }
    if (kind === 'xlsx') {
      assertExtensionLoaded(this.engine.extensions, 'excel', 'reading .xlsx workbooks');
    }

    const name = await this.uniqueName(dataset.id, request.name ?? stem(request.path));
    const plan = await planFileRead(this.engine, kind, request.path, { sheet: request.sheet });

    await this.engine.executeInternal(
      `CREATE OR REPLACE VIEW ${qualified(dataset.schemaName, name)} AS SELECT * FROM ${plan.expression}`,
    );

    const source: Source = {
      id: this.makeId(),
      datasetId: dataset.id,
      name,
      kind,
      origin: request.path,
      detection: plan.detection,
      addedAt: this.ports.clock.now().toISOString(),
    };
    await this.catalog.insertSource(source);
    this.ports.logger.log('info', 'Source connected', { kind, name, datasetId: dataset.id });
    return source;
  }

  private async addSqliteSource(request: AddSqliteSourceRequest): Promise<readonly Source[]> {
    assertExtensionLoaded(this.engine.extensions, 'sqlite_scanner', 'reading SQLite databases');

    if (!(await this.ports.fs.exists(request.path))) {
      throw new DateraError('SOURCE_UNAVAILABLE', `No file at ${request.path}`, {
        path: request.path,
      });
    }

    const params: DatabaseConnectionParams = {
      kind: 'sqlite',
      database: stem(request.path),
      path: request.path,
    };
    return this.attachAndRegister(request.datasetId, params, null, request.namePrefix, request.tables);
  }

  private async addDatabaseSource(request: AddDatabaseSourceRequest): Promise<readonly Source[]> {
    const extension = request.type === 'postgres' ? 'postgres_scanner' : 'mysql_scanner';
    assertExtensionLoaded(
      this.engine.extensions,
      extension,
      `connecting to ${request.type === 'postgres' ? 'Postgres' : 'MySQL'}`,
    );

    const params: DatabaseConnectionParams = {
      kind: request.type,
      host: request.host,
      port: request.port ?? defaultPort(request.type),
      database: request.database,
      user: request.user,
    };

    // The credential goes to the keychain before the first connection attempt, and is
    // read back from there — so the only copy that outlives this call is the protected
    // one (decision D-06).
    let secretKey: string | null = null;
    if (request.password !== undefined && request.password.length > 0) {
      if (!(await this.ports.secrets.isAvailable())) {
        throw new DateraError(
          'SECRET_STORE_UNAVAILABLE',
          'No protected credential store is available, and Datera will not write a database password to disk in plaintext. ' +
            'Connect without a password, or run in an environment with an OS keychain.',
          { host: request.host, database: request.database },
        );
      }
      secretKey = `db:${redactedOrigin(params)}`;
      await this.ports.secrets.set(secretKey, request.password);
    }

    const password = secretKey === null ? null : await this.ports.secrets.get(secretKey);
    return this.attachAndRegister(
      request.datasetId,
      params,
      secretKey,
      request.namePrefix,
      request.tables,
      password,
    );
  }

  private async attachAndRegister(
    datasetId: string | undefined,
    params: DatabaseConnectionParams,
    secretKey: string | null,
    namePrefix: string | undefined,
    tables: readonly string[] | undefined,
    password: string | null = null,
  ): Promise<readonly Source[]> {
    const dataset = datasetId === undefined ? await this.defaultDataset() : await this.getDataset(datasetId);
    const alias = await this.uniqueAlias(params.database);

    await attachDatabase(this.engine, params, alias, password);

    const available = [
      ...(await listAttachedTables(this.engine, alias)),
      ...(await listAttachedViews(this.engine, alias)),
    ];
    const wanted = tables === undefined ? available : available.filter((t) => tables.includes(t));

    if (wanted.length === 0) {
      throw new DateraError(
        'SOURCE_UNAVAILABLE',
        `Connected to ${redactedOrigin(params)} but found no readable tables${tables === undefined ? '' : ' matching the requested list'}.`,
        { origin: redactedOrigin(params), availableTables: available },
      );
    }

    const created: Source[] = [];
    for (const table of wanted) {
      const name = await this.uniqueName(dataset.id, namePrefix === undefined ? table : `${namePrefix}${table}`);
      await this.engine.executeInternal(
        `CREATE OR REPLACE VIEW ${qualified(dataset.schemaName, name)} AS SELECT * FROM ${quoteIdent(alias)}.${quoteIdent(table)}`,
      );

      const source: Source = {
        id: this.makeId(),
        datasetId: dataset.id,
        name,
        kind: params.kind,
        origin: redactedOrigin(params),
        table,
        attachmentAlias: alias,
        secretKey: secretKey ?? undefined,
        detection: {
          method: `${params.kind} ATTACH (READ_ONLY)`,
          settings: {
            alias,
            table,
            ...(params.host === undefined ? {} : { host: params.host }),
            ...(params.port === undefined ? {} : { port: String(params.port) }),
            ...(params.user === undefined ? {} : { user: params.user }),
            ...(params.path === undefined ? {} : { path: params.path }),
            database: params.database,
            readOnly: 'true — DuckDB refuses writes to this catalog',
          },
        },
        addedAt: this.ports.clock.now().toISOString(),
      };
      await this.catalog.insertSource(source);
      created.push(source);
    }

    this.ports.logger.log('info', 'Database connected read-only', {
      kind: params.kind,
      origin: redactedOrigin(params),
      tables: created.length,
    });
    return created;
  }

  /**
   * Re-establish attachments after reopening a workspace.
   *
   * Views persist in workspace.duckdb, but DuckDB attachments do not survive a restart,
   * so every view over an attached database would fail until this runs. A failure here is
   * not fatal — the affected sources simply report `unavailable`, which is the honest
   * state for a database that is currently unreachable.
   */
  private async reattachDatabases(): Promise<void> {
    const sources = await this.catalog.listSources();
    const seen = new Set<string>();

    for (const source of sources) {
      const alias = source.attachmentAlias;
      if (alias === undefined || seen.has(alias)) continue;
      seen.add(alias);

      const params = this.connectionParamsFor(source);
      if (params === null) continue;

      const password = source.secretKey === undefined ? null : await this.ports.secrets.get(source.secretKey);
      try {
        await attachDatabase(this.engine, params, alias, password);
      } catch (e) {
        this.ports.logger.log('warn', 'Could not reattach a database source', {
          origin: source.origin,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  private connectionParamsFor(source: Source): DatabaseConnectionParams | null {
    const s = source.detection.settings;
    switch (source.kind) {
      case 'sqlite':
        return { kind: 'sqlite', database: source.origin, path: s['path'] ?? source.origin };
      case 'postgres':
      case 'mysql': {
        const database = s['database'];
        if (database === undefined) return null;
        const port = s['port'];
        return {
          kind: source.kind,
          database,
          host: s['host'],
          port: port === undefined ? undefined : Number(port),
          user: s['user'],
        };
      }
      default:
        return null;
    }
  }

  async removeSource(id: string): Promise<void> {
    const source = (await this.catalog.listSources()).find((s) => s.id === id);
    if (source === undefined) {
      throw new DateraError('SOURCE_NOT_FOUND', `No source with id "${id}"`, { sourceId: id });
    }
    const dataset = await this.getDataset(source.datasetId);

    // Drops the view Datera created. The source file or database is untouched — there is
    // no code path here that deletes anything a user connected (invariant §1.2).
    await this.engine.executeInternal(
      `DROP VIEW IF EXISTS ${qualified(dataset.schemaName, source.name)}`,
    );
    await this.catalog.deleteSource(id);
  }

  // ------------------------------------------------------------ schema, read

  async getSchema(sourceId: string): Promise<SourceSchema> {
    const source = await this.getSource(sourceId);
    if (source.status.availability === 'unavailable') {
      throw new DateraError('SOURCE_UNAVAILABLE', `"${source.name}" is not available: ${source.status.reason ?? 'unknown reason'}`, {
        sourceId,
        origin: source.origin,
      });
    }
    const dataset = await this.getDataset(source.datasetId);
    return introspectSource(this.engine, source, dataset.schemaName);
  }

  /**
   * A bounded window onto a source. Never materialises the whole thing: the LIMIT is
   * pushed into the scan, so previewing row 1 of a very large Parquet reads very little.
   */
  async preview(sourceId: string, options: PreviewOptions = {}): Promise<PreviewResult> {
    const source = await this.getSource(sourceId);
    const dataset = await this.getDataset(source.datasetId);

    const limit = clamp(options.limit ?? DEFAULT_PREVIEW_LIMIT, 1, MAX_PREVIEW_LIMIT);
    const offset = Math.max(0, options.offset ?? 0);

    // One extra row tells us whether there is a next page without a second count query.
    const result = await this.engine.executeInternal(
      `SELECT * FROM ${qualified(dataset.schemaName, source.name)} LIMIT ${limit + 1} OFFSET ${offset}`,
    );

    const hasMore = result.rows.length > limit;
    return {
      sourceId,
      columns: result.columns.map((c) => ({ name: c.name, type: c.type })),
      rows: result.rows.slice(0, limit),
      limit,
      offset,
      hasMore,
    };
  }

  /**
   * Run read-only SQL against one dataset.
   *
   * The dataset's schema is set as the search path, so unqualified names resolve inside
   * it. Note that this is scoping, not isolation — enforcing that a query cannot *reach*
   * another dataset is acceptance criterion §12.4 and belongs to Phase 3, which is why
   * this method takes an explicit datasetId now rather than being retrofitted later.
   */
  async query(datasetId: string, sql: string): Promise<QueryResult> {
    const dataset = await this.getDataset(datasetId);
    await this.engine.executeInternal(`SET search_path = ${quoteIdent(dataset.schemaName)}`);

    // Two independent checks, and the ORDER MATTERS. Read-only (§1.1) first, dataset
    // boundary (§12.4) second.
    //
    // The scope check works by asking DuckDB to serialise the statement, which only
    // succeeds for a SELECT. Run it first and every write comes back as "could not
    // determine which tables this reads" — technically a refusal, but it would tell a
    // user their DELETE was a scoping problem, which is both wrong and unhelpful.
    await assertReadOnlySql(this.engine.classificationConnection(), sql);
    await this.assertScoped(sql, dataset);

    const { resultSet, check, durationMs } = await this.engine.executeUserQuery(sql, () =>
      this.ports.clock.monotonicMs(),
    );

    return {
      datasetId,
      sql: check.sql,
      statementKinds: check.statementKinds,
      columns: resultSet.columns.map((c) => ({ name: c.name, type: c.type })),
      rows: resultSet.rows,
      durationMs,
    };
  }

  // ------------------------------------------------------------ models (§9)

  /**
   * What models are available right now, across all three tiers.
   *
   * Detection is best-effort: a runtime that is not running is simply absent, and a slow
   * or broken one is skipped rather than allowed to hold up the caller. Nothing here
   * throws because a model is missing — that is the normal state of a fresh install.
   */
  async listModels(): Promise<ModelCatalogue> {
    const detected = await detectLocalRuntimes({ http: this.http });

    const remote: ModelDescriptor[] = [];
    for (const [provider, ids] of Object.entries(KNOWN_REMOTE_MODELS)) {
      const key = await this.ports.secrets.get(apiKeySecretName(provider));
      if (key === null || key.length === 0) continue;
      for (const id of ids) {
        remote.push({
          tier: 'remote', provider, id, role: 'chat', locality: 'remote', label: id,
        });
      }
    }

    const selected = await this.selectedChatModelDescriptor();
    const selectedEmbedding = await this.selectedEmbeddingDescriptor();

    const embeddingCandidates = detected
      .flatMap((r) => r.models)
      .filter((m) => looksLikeEmbeddingModel(m.id))
      .map((m) => ({ ...m, role: 'embedding' as const }));

    return {
      detected,
      remote,
      selected,
      selectedName: selected === null ? null : describeModel(selected),
      selectedEmbedding,
      selectedEmbeddingName: selectedEmbedding === null ? null : describeModel(selectedEmbedding),
      embeddingCandidates,
    };
  }

  /**
   * Choose the embedding model — always a separate act from choosing chat (§1.6).
   *
   * There is deliberately no fallback that picks a remote embedder because chat is
   * remote: the structured path sends a model your schema, the semantic path sends it
   * your *text*, and that difference should never be decided implicitly.
   */
  async setEmbeddingModel(descriptor: ModelDescriptor): Promise<void> {
    await this.catalog.setSetting(EMBEDDING_MODEL_SETTING, JSON.stringify({ ...descriptor, role: 'embedding' }));
    this.ports.logger.log('info', 'Embedding model selected', {
      model: describeModel(descriptor),
      locality: descriptor.locality,
    });
  }

  private async selectedEmbeddingDescriptor(): Promise<ModelDescriptor | null> {
    const raw = await this.catalog.getSetting(EMBEDDING_MODEL_SETTING);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as ModelDescriptor;
    } catch {
      return null;
    }
  }

  private async embeddingModel(): Promise<EmbeddingModel | null> {
    const descriptor = await this.selectedEmbeddingDescriptor();
    if (descriptor === null) return null;

    const baseUrl =
      descriptor.endpoint ?? (descriptor.provider === 'openai' ? 'https://api.openai.com' : null);
    if (baseUrl === null) return null;

    const apiKey =
      descriptor.locality === 'remote'
        ? (await this.ports.secrets.get(apiKeySecretName(descriptor.provider))) ?? undefined
        : undefined;

    return new OpenAICompatibleEmbeddingModel({
      http: this.http, baseUrl, modelId: descriptor.id, descriptor, apiKey,
    });
  }

  // ------------------------------------------------------- semantic (§5, Phase 4)

  /** Embed the dataset's text columns. Unchanged text is never re-embedded. */
  async buildEmbeddings(datasetId: string): Promise<BuildResult> {
    const dataset = await this.getDataset(datasetId);
    const model = await this.embeddingModel();
    if (model === null) {
      throw new DateraError(
        'MODEL_UNAVAILABLE',
        'No embedding model is configured. Choose one in Models — a local embedder keeps your text on this machine.',
        { datasetId },
      );
    }

    const schemas = await this.datasetSchemas(datasetId, dataset.schemaName);
    const dictionaries: SourceDictionary[] = [];
    for (const source of (await this.listSources()).filter((s) => s.datasetId === datasetId)) {
      dictionaries.push(await this.getDictionary(source.id));
    }

    return runBuildEmbeddings({
      engine: this.engine,
      model,
      datasetId,
      schemaName: dataset.schemaName,
      schemas,
      dictionaries,
      makeId: this.makeId,
      hash: simpleHash,
    });
  }

  /** Closest embedded chunks to a phrase, scoped to one dataset. */
  async semanticSearch(datasetId: string, text: string, k = 5): Promise<readonly SearchHit[]> {
    await this.getDataset(datasetId);
    const model = await this.embeddingModel();
    if (model === null) return [];

    const [vector] = await model.embed([text]);
    if (vector === undefined) return [];
    return searchVectors(this.engine, datasetId, vector, k);
  }

  async embeddingStatus(datasetId: string): Promise<{ chunks: number; columns: readonly string[] }> {
    await this.getDataset(datasetId);
    return {
      chunks: await countEmbedded(this.engine, datasetId),
      columns: await embeddedColumns(this.engine, datasetId),
    };
  }

  /** Choose the chat model. Persisted, and separate from the embedding model (§1.6). */
  async setChatModel(descriptor: ModelDescriptor): Promise<void> {
    await this.catalog.setSetting(CHAT_MODEL_SETTING, JSON.stringify(descriptor));
    this.ports.logger.log('info', 'Chat model selected', {
      model: describeModel(descriptor),
      tier: descriptor.tier,
    });
  }

  /**
   * Store an API key for a remote provider.
   *
   * Goes straight to the OS keychain and is never written to the catalog, a config file,
   * or a log line (spec §9, decision D-06). A host without protected storage is refused
   * rather than silently downgraded.
   */
  async setApiKey(provider: string, apiKey: string): Promise<void> {
    if (!(await this.ports.secrets.isAvailable())) {
      throw new DateraError(
        'SECRET_STORE_UNAVAILABLE',
        'No protected credential store is available, and Datera will not write an API key to disk in plaintext.',
        { provider },
      );
    }
    await this.ports.secrets.set(apiKeySecretName(provider), apiKey);
    this.ports.logger.log('info', 'API key stored', { provider });
  }

  async hasApiKey(provider: string): Promise<boolean> {
    const key = await this.ports.secrets.get(apiKeySecretName(provider));
    return key !== null && key.length > 0;
  }

  async clearApiKey(provider: string): Promise<void> {
    await this.ports.secrets.delete(apiKeySecretName(provider));
  }

  private async selectedChatModelDescriptor(): Promise<ModelDescriptor | null> {
    const raw = await this.catalog.getSetting(CHAT_MODEL_SETTING);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as ModelDescriptor;
    } catch {
      return null;
    }
  }

  /** Build a live client for the selected model, fetching its key at the last moment. */
  private async chatModel(): Promise<ChatModel | null> {
    const descriptor = await this.selectedChatModelDescriptor();
    if (descriptor === null) return null;

    if (descriptor.provider === 'anthropic') {
      const apiKey = await this.ports.secrets.get(apiKeySecretName('anthropic'));
      if (apiKey === null) return null;
      return new AnthropicChatModel({ http: this.http, apiKey, modelId: descriptor.id });
    }

    const apiKey =
      descriptor.locality === 'remote'
        ? (await this.ports.secrets.get(apiKeySecretName(descriptor.provider))) ?? undefined
        : undefined;

    const baseUrl =
      descriptor.endpoint ?? (descriptor.provider === 'openai' ? 'https://api.openai.com' : null);
    if (baseUrl === null) return null;

    return new OpenAICompatibleChatModel({
      http: this.http,
      baseUrl,
      modelId: descriptor.id,
      descriptor,
      apiKey,
    });
  }

  // ----------------------------------------------------------------- asking

  /**
   * Ask a question in natural language (spec §5).
   *
   * Everything about how the answer was produced comes back in `trace`. Datera declines
   * rather than guesses: see query/ask.ts for the three ways that happens.
   */
  async ask(
    datasetId: string,
    question: string,
    options: { readonly topK?: number } = {},
  ): Promise<AskResult> {
    const dataset = await this.getDataset(datasetId);
    const model = await this.chatModel();

    const sources = (await this.listSources()).filter(
      (s) => s.datasetId === datasetId && s.status.availability === 'available',
    );
    const schemas: SourceSchema[] = [];
    const dictionaries: SourceDictionary[] = [];
    for (const source of sources) {
      schemas.push(await introspectSource(this.engine, source, dataset.schemaName));
      dictionaries.push(await this.getDictionary(source.id));
    }

    const relationships = (await this.catalog.listRelationships(datasetId)).filter(
      (r) => r.state === 'confirmed',
    );

    return ask({
      engine: this.engine,
      model,
      datasetId,
      datasetName: dataset.name,
      schemaName: dataset.schemaName,
      schemaToDataset: await this.schemaToDatasetName(),
      schemas,
      dictionaries,
      relationships,
      embeddingModel: await this.embeddingModel(),
      embeddedColumns: await embeddedColumns(this.engine, datasetId),
      search: async (vector, k) => searchVectors(this.engine, datasetId, vector, k),
      ...(options.topK === undefined ? {} : { topK: options.topK }),
      question,
      traceId: this.makeId(),
      now: () => this.ports.clock.now(),
      monotonicMs: () => this.ports.clock.monotonicMs(),
    });
  }

  /**
   * What a statement physically touched (spec §5).
   *
   * Runs the same guards as a query, because explaining a statement means parsing it, and
   * a statement that would be refused should not be explained as though it were fine.
   */
  async explainTouched(datasetId: string, sql: string, rowsReturned = 0): Promise<TouchedSummary> {
    const dataset = await this.getDataset(datasetId);
    await this.engine.executeInternal(`SET search_path = ${quoteIdent(dataset.schemaName)}`);
    // Same order as query(): a write is a write, not a scoping problem.
    await assertReadOnlySql(this.engine.classificationConnection(), sql);
    await this.assertScoped(sql, dataset);

    const schemas = await this.datasetSchemas(datasetId, dataset.schemaName);
    return summariseTouched(this.engine, sql, schemas, rowsReturned);
  }

  // ------------------------------------------------------------ dictionary (§4)

  /**
   * Propose a dictionary for a source, computed from its data.
   *
   * Nothing is stored and nothing is confirmed — this is a proposal for a human to edit
   * and ratify (§1.3). Call it as often as you like; it is deterministic.
   */
  async draftDictionary(sourceId: string): Promise<SourceDictionary> {
    const source = await this.getSource(sourceId);
    const dataset = await this.getDataset(source.datasetId);
    const schema = await introspectSource(this.engine, source, dataset.schemaName);
    return draftDictionary(this.engine, dataset.schemaName, schema);
  }

  /** What is actually stored — columns with no definition report as `undefined`. */
  async getDictionary(sourceId: string): Promise<SourceDictionary> {
    const source = await this.getSource(sourceId);
    const dataset = await this.getDataset(source.datasetId);
    const schema = await introspectSource(this.engine, source, dataset.schemaName);

    const stored = new Map(
      (await this.catalog.listColumnDefinitions(sourceId)).map((d) => [d.column, d]),
    );

    return {
      sourceId,
      sourceName: source.name,
      entity: (await this.catalog.getEntityDefinition(sourceId)) ?? UNDEFINED_ENTITY,
      columns: schema.columns.map(
        (c) =>
          stored.get(c.name) ?? {
            column: c.name,
            meaning: '',
            aliases: [],
            unit: '',
            role: 'dimension' as const,
            sensitivity: 'normal' as const,
            state: 'undefined' as const,
          },
      ),
    };
  }

  /** Ratify (or edit and ratify) a column definition. */
  async confirmColumn(sourceId: string, definition: ColumnDefinition): Promise<void> {
    await this.getSource(sourceId);
    await this.catalog.upsertColumnDefinition(sourceId, definition);
  }

  async confirmEntity(sourceId: string, definition: EntityDefinition): Promise<void> {
    await this.getSource(sourceId);
    await this.catalog.upsertEntityDefinition(sourceId, definition);
  }

  // --------------------------------------------------- relationships (§3)

  /**
   * Propose links between sources in a dataset. Measured, and stores nothing (§1.3).
   */
  async detectRelationships(datasetId: string): Promise<readonly RelationshipProposal[]> {
    const dataset = await this.getDataset(datasetId);
    const schemas = await this.datasetSchemas(datasetId, dataset.schemaName);
    return detectRelationshipsIn(this.engine, dataset.schemaName, datasetId, schemas);
  }

  /** Ratify a proposed link. Only confirmed links reach the model. */
  async confirmRelationship(
    datasetId: string,
    proposal: Omit<AuthoredRelationship, 'id' | 'createdAt' | 'state'>,
  ): Promise<AuthoredRelationship> {
    await this.getDataset(datasetId);
    const relationship: AuthoredRelationship = {
      id: this.makeId(),
      datasetId,
      fromTable: proposal.fromTable,
      fromColumn: proposal.fromColumn,
      toTable: proposal.toTable,
      toColumn: proposal.toColumn,
      state: 'confirmed',
      createdAt: this.ports.clock.now().toISOString(),
    };
    await this.catalog.insertRelationship(relationship);
    return relationship;
  }

  private async datasetSchemas(datasetId: string, schemaName: string): Promise<readonly SourceSchema[]> {
    const sources = (await this.listSources()).filter(
      (s) => s.datasetId === datasetId && s.status.availability === 'available',
    );
    const schemas: SourceSchema[] = [];
    for (const source of sources) {
      schemas.push(await introspectSource(this.engine, source, schemaName));
    }
    return schemas;
  }

  // --------------------------------------------------------------- authoring

  /**
   * Create a dataset with no source attached (spec §3a).
   *
   * The Phase 1 seam for "author from intent". A dataset is a boundary and a schema; it
   * does not need a file to exist. Phase 3 builds dataset management on this, and the
   * later authoring UI builds on it again.
   */
  async createDataset(input: {
    readonly id?: string | undefined;
    readonly name: string;
    readonly description?: string | undefined;
  }): Promise<Dataset> {
    assertAuthorableName(input.name, 'dataset');

    const id = input.id ?? this.makeId();
    const existing = await this.catalog.listDatasets();
    if (existing.some((d) => d.id === id)) {
      throw new DateraError('DUPLICATE_NAME', `A dataset with id "${id}" already exists`, {
        datasetId: id,
      });
    }

    const schemaName = await this.uniqueSchemaName(input.name);
    const dataset: Dataset = {
      id,
      name: input.name,
      description: input.description ?? '',
      schemaName,
      isDefault: false,
      createdAt: this.ports.clock.now().toISOString(),
    };

    await this.engine.executeInternal(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schemaName)}`);
    await this.catalog.insertDataset(dataset);
    this.ports.logger.log('info', 'Dataset authored', { datasetId: id, schemaName });
    return dataset;
  }

  /**
   * Define a typed table inside a dataset, with no source behind it (spec §3a).
   *
   * Structural authoring in the workspace — not the gated data-write path of §6, which
   * governs changing rows. Creating a real DuckDB table means introspection, preview and
   * the read-only query path all treat an authored table exactly as they treat a
   * connected source: one internal model, two entry paths.
   */
  async defineTable(datasetId: string, table: AuthoredTable): Promise<SourceSchema> {
    const dataset = await this.getDataset(datasetId);
    await createAuthoredTable(this.engine, dataset.schemaName, table);
    this.ports.logger.log('info', 'Table authored', {
      datasetId,
      table: table.name,
      columns: table.columns.length,
    });
    return this.describeTable(datasetId, table.name);
  }

  /** Declare a relationship between two tables in one dataset. */
  async defineRelationship(
    datasetId: string,
    input: {
      readonly fromTable: string;
      readonly fromColumn: string;
      readonly toTable: string;
      readonly toColumn: string;
    },
  ): Promise<AuthoredRelationship> {
    const dataset = await this.getDataset(datasetId);

    // Both ends must exist in *this* dataset. A relationship that reaches outside the
    // dataset boundary would be the first crack in acceptance §12.4.
    for (const [table, column] of [
      [input.fromTable, input.fromColumn],
      [input.toTable, input.toColumn],
    ] as const) {
      const schema = await this.describeTable(datasetId, table);
      if (!schema.columns.some((c) => c.name === column)) {
        throw new DateraError(
          'INVALID_ARGUMENT',
          `Column "${column}" does not exist on "${table}" in dataset "${dataset.name}"`,
          { datasetId, table, column },
        );
      }
    }

    const relationship: AuthoredRelationship = {
      id: this.makeId(),
      datasetId,
      fromTable: input.fromTable,
      fromColumn: input.fromColumn,
      toTable: input.toTable,
      toColumn: input.toColumn,
      state: 'confirmed',
      createdAt: this.ports.clock.now().toISOString(),
    };
    await this.catalog.insertRelationship(relationship);
    return relationship;
  }

  async listRelationships(datasetId?: string): Promise<readonly AuthoredRelationship[]> {
    return this.catalog.listRelationships(datasetId);
  }

  /**
   * Introspect any relation in a dataset by name — authored table or connected source.
   *
   * Deliberately name-addressed rather than source-id-addressed: an authored table has no
   * source id, and requiring one would reintroduce exactly the "every dataset comes from
   * a file" coupling that §3a exists to prevent.
   */
  async describeTable(datasetId: string, tableName: string): Promise<SourceSchema> {
    const dataset = await this.getDataset(datasetId);
    return introspectRelation(this.engine, dataset.schemaName, tableName, datasetId);
  }

  /** Every relation in a dataset's schema, authored or connected. */
  async listTables(datasetId: string): Promise<readonly string[]> {
    const dataset = await this.getDataset(datasetId);
    const result = await this.engine.executeInternal(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = ? ORDER BY table_name`,
      [dataset.schemaName],
    );
    return result.rows.map((row) => String(row[0]));
  }

  private async uniqueSchemaName(desired: string): Promise<string> {
    const base = `ds_${slugifyIdent(desired, 'dataset')}`;
    const existing = await this.engine.executeInternal(
      'SELECT schema_name FROM information_schema.schemata',
    );
    const taken = new Set(existing.rows.map((r) => String(r[0])));
    if (!taken.has(base)) return base;
    for (let i = 2; i < 1000; i += 1) {
      if (!taken.has(`${base}_${i}`)) return `${base}_${i}`;
    }
    throw new DateraError('DUPLICATE_NAME', `Could not find a free schema name for "${desired}"`, {});
  }

  /** Shared by the SQL path and the NL path: a model gets no more latitude than a user. */
  private async assertScoped(sql: string, dataset: Dataset): Promise<void> {
    const datasets = await this.catalog.listDatasets();
    const schemaToDataset = new Map(datasets.map((d) => [d.schemaName, d.name]));

    // Attachment aliases for databases connected *into this dataset*. They are this
    // dataset's own sources under their real catalog names, not foreign schemas.
    const ownAttachments = new Set(
      (await this.catalog.listSources())
        .filter((s) => s.datasetId === dataset.id && s.attachmentAlias !== undefined)
        .map((s) => s.attachmentAlias as string),
    );

    await assertWithinDataset(
      this.engine.classificationConnection(),
      sql,
      dataset.schemaName,
      dataset.name,
      schemaToDataset,
      ownAttachments,
    );
  }

  /** Dataset schema names, so the scope guard can name what a query reached for. */
  private async schemaToDatasetName(): Promise<ReadonlyMap<string, string>> {
    const datasets = await this.catalog.listDatasets();
    return new Map(datasets.map((d) => [d.schemaName, d.name]));
  }

  async close(): Promise<void> {
    await this.engine.close();
  }

  // ------------------------------------------------------------------ naming

  private async uniqueName(datasetId: string, desired: string): Promise<string> {
    const base = sanitiseSourceName(desired);
    if (!(await this.catalog.nameExists(datasetId, base))) return base;

    for (let i = 2; i < 1000; i += 1) {
      const candidate = `${base}_${i}`;
      if (!(await this.catalog.nameExists(datasetId, candidate))) return candidate;
    }
    throw new DateraError('DUPLICATE_NAME', `Could not find a free name based on "${base}"`, {
      datasetId,
      desired,
    });
  }

  private async uniqueAlias(desired: string): Promise<string> {
    const base = slugifyIdent(desired, 'db');
    const existing = await this.engine.executeInternal('SELECT database_name FROM duckdb_databases()');
    const taken = new Set(existing.rows.map((r) => String(r[0])));
    if (!taken.has(base)) return base;
    for (let i = 2; i < 1000; i += 1) {
      if (!taken.has(`${base}_${i}`)) return `${base}_${i}`;
    }
    throw new DateraError('DUPLICATE_NAME', `Could not find a free attachment alias for "${desired}"`, {});
  }
}

function sanitiseSourceName(name: string): string {
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed : 'source';
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.trunc(n)));
}

export type { ResultSet };

/**
 * Remote models offered once a key is present.
 *
 * A short curated list rather than a live catalogue call: it keeps model selection
 * working offline, and the ids are checked against the pricing table so the cost line is
 * never a guess. Anything missing can still be reached by an explicit descriptor.
 */
const KNOWN_REMOTE_MODELS: Readonly<Record<string, readonly string[]>> = {
  anthropic: ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5'],
  openai: ['gpt-4o', 'gpt-4o-mini'],
};


/**
 * A short content hash for "has this text already been embedded".
 *
 * FNV-1a rather than sha-256 because the core has no crypto port: this is a cache key, not
 * a security boundary, and a collision costs a redundant re-embed.
 */
function simpleHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${hash.toString(16)}-${text.length}`;
}
