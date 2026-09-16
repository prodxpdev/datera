import { asDateraError, DateraError } from './errors.js';
import { Engine } from './engine/engine.js';
import { assertExtensionLoaded } from './engine/extensions.js';
import { assertReadOnlySql } from './engine/read-only.js';
import { qualified, quoteIdent, quoteLiteral, slugifyIdent } from './engine/sql.js';
import type { DuckDBDriverPort, ResultSet, SqlParam, StatementKind } from './ports/duckdb.js';
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
  diffVersions as diffVersionsIn, getVersion, listVersions as listVersionsIn,
  migrateVersions, saveVersion as saveVersionIn, tablesIn,
  type Version, type VersionDiff,
} from './cow/versions.js';
import {
  exportDataset as runExportDataset, parseManifest, MANIFEST_FILE,
  type ExportFormat, type ExportManifest, type ExportResult,
} from './cow/export.js';
import { joinPath } from './util/paths.js';
import {
  applyNormalization, proposeEnums, proposeNormalization,
  type EnumProposal, type NormalizationProposal,
} from './cow/normalize.js';
import { toolsFor, toolSuffix, type ToolContext, type ToolDefinition } from './serve/tools.js';
import {
  LOCAL_ENVIRONMENT_ID, environmentTokenKey,
  type Environment, type EnvironmentStatus,
} from './environments/types.js';
import { RemoteDatera } from './environments/remote.js';
import { DEFAULT_LIFECYCLE, validateLifecycle, type Lifecycle } from './teaching/lifecycle.js';

/** Pull the offending identifier out of DuckDB's binder error, for a readable message. */
function describeMissing(bindError: string): string {
  const column = /Referenced column "([^"]+)" not found/.exec(bindError)?.[1];
  if (column !== undefined) return `a column called "${column}"`;

  const table = /Table with name ([^\s]+) does not exist/.exec(bindError)?.[1];
  if (table !== undefined) return `a table called "${table}"`;

  return 'something';
}
import { deriveLifecycle } from './teaching/derive.js';
import { connectConfig as buildConnectConfig, type ClientId, type ConnectConfig, type ConfigOptions } from './serve/configs.js';
import {
  DEFAULT_RETENTION, migrateTraceLog, pruneTraceLog as prune, queryTraceLog as runTraceQuery,
  recordTrace, type RetentionPolicy, type TraceOrigin, type TraceQuery, type TraceRecord,
} from './serve/trace-log.js';
import {
  applyWrite, assertWriteInDataset, classifyWrite, grant as grantWriteIn, isGranted,
  migrateWrites, previewWrite, restore, revoke as revokeWriteIn,
  type AppliedWrite, type WriteProposal,
} from './writes/writes.js';
import {
  countEmbedded, embeddedColumns, migrateEmbeddings, searchVectors, type SearchHit,
} from './semantic/store.js';
import {
  OpenAICompatibleEmbeddingModel, looksLikeEmbeddingModel, type EmbeddingModel,
} from './models/embeddings.js';
import {
  BUNDLED_MODELS, BundledChatModel, bundledModel, recommendBundledModel,
  type BundledModelSpec,
} from './models/bundled.js';
import type { LocalModelStatus } from './ports/llm.js';
import {
  assertOperationName, assertParametersMatch, bindArguments, inlineArguments, operationTool,
  type AuthoredOperation, type CreateOperationInput,
} from './serve/operations.js';
import { sheetNamesFrom } from './sources/workbook.js';
import { draftDictionary } from './dictionary/draft.js';
import type { GraphTable, SchemaGraph } from './query/schema-graph.js';
import {
  UNDEFINED_ENTITY,
  confirmedOnly,
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
import { TraceBuilder, type Trace } from './query/trace.js';
import { buildSchemaContext } from './query/context.js';
import { extractSql } from './query/sql-extract.js';
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
const TRACE_PAYLOADS_SETTING = 'trace.capturePayloads';
const TRACE_RETENTION_SETTING = 'trace.retention';
const ENVIRONMENTS_SETTING = 'environments';
const LIFECYCLE_SETTING = 'teaching.lifecycle';

/** What a served tool call returns, in the shape MCP expects. */
export interface ToolResult {
  readonly content: readonly { type: 'text'; text: string }[];
  readonly isError: boolean;
  /** The end-to-end record for this call (§12.9). */
  readonly trace?: Trace | undefined;
}
/** Keychain entry holding the API key for a remote provider. One per provider. */
export const apiKeySecretName = (provider: string): string => `model.apiKey.${provider}`;

/** A bundled model, with what it would cost this machine in disk and memory. */
export interface BundledModelOffer {
  readonly modelId: string;
  readonly spec: BundledModelSpec;
  /** The size this machine should be offered first. Exactly one is true. */
  readonly recommended: boolean;
  readonly ready: boolean;
  readonly bytesOnDisk: number;
  readonly unavailableReason: string | null;
}

/**
 * A stand-in value of the right type, used only to make a parameterised statement
 * parseable while its kind is measured. Never executed, never stored.
 */
function sampleFor(type: 'string' | 'number' | 'boolean' | 'date'): string | number | boolean {
  switch (type) {
    case 'number': return 0;
    case 'boolean': return false;
    case 'date': return '1970-01-01';
    case 'string': return '';
  }
}

/** What calling an authored operation produced: rows, or a change awaiting confirmation. */
export interface OperationResult {
  readonly kind: 'read' | 'write';
  readonly columns?: readonly string[] | undefined;
  readonly rows?: readonly (readonly unknown[])[] | undefined;
  /** Present for a write. Nothing has been applied until this is confirmed.  */
  readonly proposal?: WriteProposal | undefined;
}

/** A dataset and where it lives, so one picker can offer both. */
export interface ReachableDataset {
  readonly environmentId: string;
  readonly environmentName: string;
  readonly dataset: Dataset;
  readonly remote: boolean;
}

export interface ModelCatalogue {
  /**
   * The bundled tier (§9 tier 1). Empty when the host supplies no runtime — a model that
   * cannot run must not appear in a picker, because offering it and failing at call time
   * teaches the user the product is broken rather than that their host lacks the port.
   */
  readonly bundled: readonly BundledModelOffer[];
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

  /**
   * Proposals awaiting confirmation.
   *
   * Deliberately in memory and not persisted: a proposal's preview describes the data as
   * it was a moment ago, and resurrecting one after a restart would invite confirming a
   * change whose "this will affect 1,203 rows" is no longer true.
   */
  private readonly pendingWrites = new Map<string, WriteProposal>();

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
    await migrateVersions(engine);
    await migrateWrites(engine);
    await migrateTraceLog(engine);

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
      kind: 'connected',
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
  /**
   * The sheets in an .xlsx workbook, in workbook order (#31).
   *
   * Empty rather than throwing when the file is not a readable workbook, or when the host
   * cannot open a zip: this is called speculatively the moment a file is chosen, and a
   * picker that errors about sheets on a CSV is worse than one that simply does not ask.
   */
  async listWorkbookSheets(path: string): Promise<readonly string[]> {
    const readZipEntry = this.ports.fs.readZipEntry?.bind(this.ports.fs);
    if (readZipEntry === undefined) return [];

    try {
      const xml = await readZipEntry(path, 'xl/workbook.xml');
      return xml === null ? [] : sheetNamesFrom(xml);
    } catch {
      return [];
    }
  }

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
  async query(
    datasetId: string,
    sql: string,
    /** Bound after the guard has approved the statement, never interpolated into it. */
    params?: readonly SqlParam[],
  ): Promise<QueryResult> {
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

    const { resultSet, check, durationMs } = await this.engine.executeUserQuery(
      sql,
      () => this.ports.clock.monotonicMs(),
      params,
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
    const bundled = await this.bundledOffers();

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
      bundled,
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

  /**
   * What the host can actually run, joined to what each model costs.
   *
   * Never throws: a runtime that cannot report its status yields an unavailable entry
   * with the reason attached, because "we could not ask" is information a user can act
   * on and an exception in the model picker is not.
   */
  private async bundledOffers(): Promise<readonly BundledModelOffer[]> {
    const llm = this.ports.llm;
    if (llm === undefined) return [];

    let statuses: readonly LocalModelStatus[];
    try {
      statuses = await llm.status();
    } catch (e) {
      this.ports.logger.log('warn', 'Local model runtime could not report status', {
        error: (e as { message?: string }).message ?? String(e),
      });
      return [];
    }

    const byId = new Map(statuses.map((s) => [s.modelId, s]));
    const recommended = (await this.recommendedBundledModel())?.id ?? null;

    return BUNDLED_MODELS.map((spec) => {
      const status = byId.get(spec.id);
      return {
        modelId: spec.id,
        spec,
        recommended: spec.id === recommended,
        ready: status?.ready ?? false,
        bytesOnDisk: status?.bytesOnDisk ?? 0,
        unavailableReason: status?.unavailableReason ?? null,
      };
    });
  }

  /**
   * Which bundled model this machine should be offered.
   *
   * Null when no runtime is present. The policy is a pure function of total memory; the
   * host only reports the number.
   */
  async recommendedBundledModel(): Promise<BundledModelSpec | null> {
    const llm = this.ports.llm;
    if (llm === undefined) return null;
    try {
      return recommendBundledModel(await llm.totalMemoryBytes());
    } catch {
      return null;
    }
  }

  /**
   * Load the selected bundled model ahead of the first question.
   *
   * Fire-and-forget by design: the caller should not wait, and a failure must not surface
   * as an error. The only consequence of it not working is a slower first answer.
   */
  async warmBundledModel(): Promise<void> {
    const llm = this.ports.llm;
    if (llm === undefined) return;
    const descriptor = await this.selectedChatModelDescriptor();
    if (descriptor === null || descriptor.tier !== 'bundled') return;
    await llm.warm(descriptor.id).catch(() => undefined);
  }

  /** Fetch and verify a bundled model's weights (§9, D-08: fetched on first run). */
  async downloadBundledModel(
    modelId: string,
    onProgress?: (progress: { receivedBytes: number; totalBytes: number }) => void,
  ): Promise<void> {
    const llm = this.ports.llm;
    if (llm === undefined) {
      throw new DateraError(
        'MODEL_UNAVAILABLE',
        'This host has no local model runtime, so bundled models cannot be downloaded here.',
      );
    }
    const spec = bundledModel(modelId);
    this.ports.logger.log('info', 'Downloading bundled model', { modelId, bytes: spec.sizeBytes });
    await llm.ensure(modelId, (p) => onProgress?.({ receivedBytes: p.receivedBytes, totalBytes: p.totalBytes }));
  }

  async removeBundledModel(modelId: string): Promise<void> {
    if (this.ports.llm === undefined) return;
    await this.ports.llm.remove(bundledModel(modelId).id);
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

    // The bundled tier first: it is the only one that needs no key and no network, so it
    // is also the only one that can be selected on a machine that has neither.
    if (descriptor.tier === 'bundled') {
      if (this.ports.llm === undefined) return null;
      return new BundledChatModel(this.ports.llm, bundledModel(descriptor.id));
    }

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

    const result = await ask({
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

    await this.record(result.trace, {
      origin: 'ask',
      rowsReturned: result.rows.length,
      ok: result.answerable,
      // A decline is recorded as a failure with its reason: "Datera would not answer this,
      // and here is why" is exactly the kind of thing the log exists to make searchable.
      ...(result.answerable || result.flag === null ? {} : { error: result.flag }),
    });

    return result;
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

  // ------------------------------------------------------------ grouping (§3)

  /**
   * Move a source into another dataset.
   *
   * This is what makes grouping real: §3 calls the dataset "the one boundary that governs
   * everything", and a boundary you cannot form leaves every source in Ungrouped.
   *
   * The view is *recreated* in the target schema rather than the catalog row relabelled,
   * because the view is what the boundary is made of — a source whose row says "store"
   * while its view still lives in `ds_ungrouped` would be queryable from the wrong side.
   */
  async moveSource(sourceId: string, targetDatasetId: string): Promise<Source> {
    const source = await this.getSource(sourceId);
    const target = await this.getDataset(targetDatasetId);
    const current = await this.getDataset(source.datasetId);

    if (current.id === target.id) return source;

    const name = await this.uniqueName(target.id, source.name);

    // Read the view's definition from the schema it is in, so the move works for a file
    // source and an attached-database source alike.
    const definition = await this.viewDefinition(current.schemaName, source.name);

    await this.engine.executeInternal(
      `CREATE OR REPLACE VIEW ${qualified(target.schemaName, name)} AS ${definition}`,
    );
    await this.engine.executeInternal(
      `DROP VIEW IF EXISTS ${qualified(current.schemaName, source.name)}`,
    );
    await this.catalog.updateSourceDataset(sourceId, target.id, name);

    // Definitions describe a source, not a dataset, so they travel with it. Relationships
    // do not: they are scoped to a dataset, and a link to a table that is no longer there
    // would be a confirmed statement that had quietly become false.
    this.ports.logger.log('info', 'Source moved', {
      sourceId, from: current.id, to: target.id, name,
    });

    return { ...source, datasetId: target.id, name };
  }

  async renameDataset(datasetId: string, name: string): Promise<Dataset> {
    await this.getDataset(datasetId);
    assertAuthorableName(name, 'dataset');
    await this.catalog.renameDataset(datasetId, name);
    return this.getDataset(datasetId);
  }

  /**
   * Delete an empty dataset.
   *
   * Refused while it still holds sources: dropping them silently would destroy the user's
   * connections, and orphaning them would leave rows pointing at a schema that is gone.
   * Making them move the sources first is the honest third option.
   */
  async deleteDataset(datasetId: string): Promise<void> {
    const dataset = await this.getDataset(datasetId);

    if (dataset.isDefault) {
      throw new DateraError(
        'INVALID_ARGUMENT',
        `"${dataset.name}" is the default dataset and cannot be removed — new sources need somewhere to land.`,
        { datasetId },
      );
    }

    const held = (await this.catalog.listSources()).filter((s) => s.datasetId === datasetId);
    if (held.length > 0) {
      throw new DateraError(
        'INVALID_ARGUMENT',
        `"${dataset.name}" still holds ${held.length} source${held.length === 1 ? '' : 's'} ` +
          `(${held.map((s) => s.name).join(', ')}). Move or remove them first — Datera will not ` +
          `silently drop your connections.`,
        { datasetId, sources: held.map((s) => s.name) },
      );
    }

    await this.engine.executeInternal(`DROP SCHEMA IF EXISTS ${quoteIdent(dataset.schemaName)} CASCADE`);
    await this.catalog.deleteDataset(datasetId);
    this.ports.logger.log('info', 'Dataset deleted', { datasetId });
  }

  /** The SELECT behind a view, so a move can rebuild it elsewhere. */
  private async viewDefinition(schemaName: string, viewName: string): Promise<string> {
    const result = await this.engine.executeInternal(
      `SELECT sql FROM duckdb_views() WHERE schema_name = ? AND view_name = ?`,
      [schemaName, viewName],
    );
    const sql = result.rows[0]?.[0];
    if (typeof sql !== 'string' || sql.length === 0) {
      throw new DateraError(
        'SOURCE_UNAVAILABLE',
        `Could not read the definition of "${viewName}" — it may have been removed outside Datera.`,
        { schemaName, viewName },
      );
    }

    // duckdb_views() returns the whole CREATE VIEW statement; the move needs only its body.
    const match = /\bAS\b([\s\S]+)$/i.exec(sql);
    return (match?.[1] ?? sql).trim().replace(/;\s*$/, '');
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

  /**
   * Ratify several columns in one act.
   *
   * Still propose-then-confirm — a human read the batch and said yes to it. What this
   * removes is the per-click reload that used to discard the rest of the draft, which
   * turned ratifying twelve columns into twelve drafting runs.
   */
  async confirmColumns(sourceId: string, definitions: readonly ColumnDefinition[]): Promise<void> {
    await this.getSource(sourceId);
    for (const definition of definitions) {
      await this.catalog.upsertColumnDefinition(sourceId, definition);
    }
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

  // ------------------------------------------- copy-on-write (§1.2, Phase 5)

  /**
   * Copy a dataset into a new one whose tables are real, editable tables.
   *
   * This is the mechanism behind "operate on a copy, export the copy" (§1.2). The source
   * dataset's views still point at the untouched originals; the derived dataset holds
   * materialised data that later phases may modify without any risk to them.
   */
  async deriveDataset(
    datasetId: string,
    input: { readonly name: string; readonly description?: string },
  ): Promise<{ datasetId: string; tables: readonly string[] }> {
    const source = await this.getDataset(datasetId);
    assertAuthorableName(input.name, 'dataset');

    const schemaName = await this.uniqueSchemaName(input.name);
    const dataset: Dataset = {
      id: this.makeId(),
      name: input.name,
      description: input.description ?? `Working copy of "${source.name}". The originals are untouched.`,
      schemaName,
      isDefault: false,
      kind: 'derived',
      derivedFrom: datasetId,
      createdAt: this.ports.clock.now().toISOString(),
    };

    await this.engine.executeInternal(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schemaName)}`);

    const tables = await tablesIn(this.engine, source.schemaName);
    for (const table of tables) {
      // CREATE TABLE AS, not a view: the whole point is that this copy can change while
      // the original cannot.
      await this.engine.executeInternal(
        `CREATE TABLE ${qualified(schemaName, table)} AS SELECT * FROM ${qualified(source.schemaName, table)}`,
      );
    }

    await this.catalog.insertDataset(dataset);
    this.ports.logger.log('info', 'Dataset derived', { from: datasetId, to: dataset.id, tables: tables.length });
    return { datasetId: dataset.id, tables };
  }

  /** Snapshot a dataset. A version is a copy at a point in time (§3). */
  async saveVersion(datasetId: string, label: string): Promise<Version> {
    const dataset = await this.getDataset(datasetId);
    const version: Version = {
      id: this.makeId(),
      datasetId,
      label,
      schemaName: await this.uniqueSchemaName(`v_${dataset.name}_${label}`),
      createdAt: this.ports.clock.now().toISOString(),
    };
    return saveVersionIn(this.engine, version, dataset.schemaName);
  }

  async listVersions(datasetId: string): Promise<readonly Version[]> {
    await this.getDataset(datasetId);
    return listVersionsIn(this.engine, datasetId);
  }

  async listVersionTables(versionId: string): Promise<readonly string[]> {
    const version = await getVersion(this.engine, versionId);
    if (version === null) {
      throw new DateraError('DATASET_NOT_FOUND', `No version with id "${versionId}"`, { versionId });
    }
    return tablesIn(this.engine, version.schemaName);
  }

  /** Diff two versions. Computed from the two schemas, never from a model (§1.5). */
  async diffVersions(fromId: string, toId: string): Promise<VersionDiff> {
    const from = await getVersion(this.engine, fromId);
    const to = await getVersion(this.engine, toId);
    if (from === null || to === null) {
      throw new DateraError('DATASET_NOT_FOUND', 'One of those versions does not exist', { fromId, toId });
    }
    return diffVersionsIn(this.engine, from, to);
  }

  /**
   * Replace a table in a derived dataset from a SELECT.
   *
   * Exists so the version-diff tests can produce a genuine data change without waiting for
   * the Phase 6 write path. Refuses on anything that is not a derived dataset, so it
   * cannot be used to sidestep copy-on-write.
   */
  async replaceTableForTesting(datasetId: string, table: string, selectSql: string): Promise<void> {
    const dataset = await this.getDataset(datasetId);
    if (dataset.kind !== 'derived') {
      throw new DateraError(
        'READ_ONLY_VIOLATION',
        'Tables can only be replaced in a derived dataset — the original is never modified (§1.2).',
        { datasetId },
      );
    }
    await this.engine.executeInternal(`SET search_path = ${quoteIdent(dataset.schemaName)}`);
    await this.engine.executeInternal(
      `CREATE OR REPLACE TABLE ${qualified(dataset.schemaName, table)} AS ${selectSql}`,
    );
  }

  // ------------------------------------------------------- normalize (§7)

  /**
   * Propose splitting a flat sheet into entities. Measured, and stores nothing (§1.3).
   */
  async proposeNormalization(sourceId: string): Promise<NormalizationProposal> {
    const source = await this.getSource(sourceId);
    const dataset = await this.getDataset(source.datasetId);
    const schema = await introspectSource(this.engine, source, dataset.schemaName);
    return proposeNormalization(this.engine, dataset.schemaName, schema);
  }

  /**
   * Apply a confirmed proposal — always into a **derived** dataset (§1.2).
   *
   * The source is never restructured in place, and there is no parameter here that would
   * let a caller ask for that.
   */
  async applyNormalization(
    sourceDatasetId: string,
    proposal: NormalizationProposal,
    input: { readonly name: string },
  ): Promise<{ datasetId: string; tables: readonly string[] }> {
    const source = await this.getDataset(sourceDatasetId);
    assertAuthorableName(input.name, 'dataset');

    const schemaName = await this.uniqueSchemaName(input.name);
    const dataset: Dataset = {
      id: this.makeId(),
      name: input.name,
      description: `Normalized from "${source.name}". The original is untouched.`,
      schemaName,
      isDefault: false,
      kind: 'derived',
      derivedFrom: sourceDatasetId,
      createdAt: this.ports.clock.now().toISOString(),
    };

    await this.engine.executeInternal(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schemaName)}`);
    const tables = await applyNormalization(this.engine, source.schemaName, schemaName, proposal);
    await this.catalog.insertDataset(dataset);

    // The foreign keys the split creates are recorded as confirmed relationships: the user
    // ratified the structure, so the links it implies are ratified too.
    for (const entity of proposal.entities) {
      await this.catalog.insertRelationship({
        id: this.makeId(),
        datasetId: dataset.id,
        fromTable: proposal.factName,
        fromColumn: entity.keyColumn,
        toTable: entity.name,
        toColumn: entity.keyColumn,
        state: 'confirmed',
        createdAt: this.ports.clock.now().toISOString(),
      });
    }

    this.ports.logger.log('info', 'Normalization applied', {
      from: sourceDatasetId, to: dataset.id, tables: tables.length,
    });
    return { datasetId: dataset.id, tables };
  }

  /** Propose enum promotion for a source's small-value-set columns (§7). */
  async proposeEnums(sourceId: string): Promise<readonly EnumProposal[]> {
    const source = await this.getSource(sourceId);
    const dataset = await this.getDataset(source.datasetId);
    const schema = await introspectSource(this.engine, source, dataset.schemaName);
    return proposeEnums(this.engine, dataset.schemaName, schema);
  }

  // ------------------------------------------------ portability (§1.8, §12.11)

  /** Export everything in open formats. See cow/export.ts for what "everything" means. */
  async exportDataset(
    datasetId: string,
    directory: string,
    options: { readonly format?: ExportFormat } = {},
  ): Promise<ExportResult> {
    const dataset = await this.getDataset(datasetId);

    const dictionaries: SourceDictionary[] = [];
    for (const source of (await this.listSources()).filter((s) => s.datasetId === datasetId)) {
      dictionaries.push(await this.getDictionary(source.id));
    }

    return runExportDataset({
      engine: this.engine,
      fs: this.ports.fs,
      dataset,
      directory,
      format: options.format ?? 'parquet',
      dictionaries,
      relationships: await this.catalog.listRelationships(datasetId),
      now: () => this.ports.clock.now(),
      appVersion: this.manifest.createdBy,
    });
  }

  /**
   * Import an exported directory into this workspace.
   *
   * The other half of §12.11: the round trip has to be lossless, including the semantic
   * layer. An export that returned only rows would satisfy "you can get your data out"
   * while still losing everything that made the data understandable.
   */
  async importDataset(directory: string): Promise<{ datasetId: string; tables: readonly string[] }> {
    const manifestPath = joinPath(directory, MANIFEST_FILE);
    if (!(await this.ports.fs.exists(manifestPath))) {
      throw new DateraError('INVALID_ARGUMENT', `No ${MANIFEST_FILE} in ${directory}`, { directory });
    }

    let manifest: ExportManifest;
    try {
      manifest = parseManifest(await this.ports.fs.readTextFile(manifestPath));
    } catch (e) {
      throw asDateraError(e, 'INVALID_ARGUMENT', 'That export could not be read', { directory });
    }

    const schemaName = await this.uniqueSchemaName(manifest.dataset.name);
    const dataset: Dataset = {
      id: this.makeId(),
      name: manifest.dataset.name,
      description: manifest.dataset.description,
      schemaName,
      isDefault: false,
      kind: 'imported',
      createdAt: this.ports.clock.now().toISOString(),
    };

    await this.engine.executeInternal(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schemaName)}`);
    await this.catalog.insertDataset(dataset);

    const created: string[] = [];
    for (const table of manifest.tables) {
      const file = joinPath(directory, table.file);
      const reader = table.file.endsWith('.parquet')
        ? `read_parquet(${quoteLiteral(file)})`
        : `read_csv(${quoteLiteral(file)}, auto_detect=true)`;

      await this.engine.executeInternal(
        `CREATE TABLE ${qualified(schemaName, table.name)} AS SELECT * FROM ${reader}`,
      );

      // Registered as a source so the imported dataset behaves like any other — it has a
      // dictionary, it can be asked questions, it can be exported again.
      const source: Source = {
        id: this.makeId(),
        datasetId: dataset.id,
        name: table.name,
        kind: table.file.endsWith('.parquet') ? 'parquet' : 'csv',
        origin: file,
        detection: {
          method: 'imported from a Datera export',
          settings: { manifest: MANIFEST_FILE, exportedBy: manifest.exportedBy },
        },
        addedAt: this.ports.clock.now().toISOString(),
      };
      await this.catalog.insertSource(source);
      created.push(table.name);

      // The semantic layer, restored. This is the part a naive export drops.
      const dictionary = manifest.dictionaries.find((d) => d.sourceName === table.name);
      if (dictionary !== undefined) {
        for (const column of dictionary.columns) {
          if (column.state === 'undefined') continue;
          await this.catalog.upsertColumnDefinition(source.id, column);
        }
        if (dictionary.entity.state !== 'undefined') {
          await this.catalog.upsertEntityDefinition(source.id, dictionary.entity);
        }
      }
    }

    for (const relationship of manifest.relationships) {
      await this.catalog.insertRelationship({
        ...relationship,
        id: this.makeId(),
        datasetId: dataset.id,
      });
    }

    this.ports.logger.log('info', 'Dataset imported', { datasetId: dataset.id, tables: created.length });
    return { datasetId: dataset.id, tables: created };
  }

  // ------------------------------------------------------------ writes (§6)

  async canWrite(datasetId: string): Promise<boolean> {
    await this.getDataset(datasetId);
    return isGranted(this.engine, datasetId);
  }

  /**
   * Grant writes on a dataset. Off by default, per dataset, revocable (§6).
   *
   * Only a **derived** dataset can be granted. A connected dataset's tables are views over
   * the user's actual files, and §1.2 says those are never written — so rather than
   * guarding that at execution time, the grant itself is refused, which puts the "no" at
   * the moment of the decision instead of the moment of the accident.
   */
  /**
   * Make this dataset writable, doing whatever that requires.
   *
   * §1.2 says Datera never writes to a connected source, and copy-on-write is how that is
   * kept. But the mechanism had become the user's problem: derive a copy, find it in the
   * list, grant writes on it, remember which one you are querying — three steps and a
   * second entry in the dataset list to express one intention. The invariant is about
   * behaviour, not about making someone perform it.
   *
   * So asking for writes on a connected dataset makes the shadow copy itself. It reuses
   * the copy it already made rather than stacking up a new one per click, and the caller
   * is told which dataset it ended up on and whether a copy was made — silently moving
   * someone to a different dataset would be worse than the ceremony it replaces.
   */
  async enableWrites(datasetId: string): Promise<{ datasetId: string; derived: boolean }> {
    const dataset = await this.getDataset(datasetId);

    if (dataset.kind !== 'connected') {
      await this.grantWrite(dataset.id);
      return { datasetId: dataset.id, derived: false };
    }

    const existing = (await this.listDatasets()).find(
      (d) => d.kind === 'derived' && d.derivedFrom === dataset.id,
    );
    if (existing !== undefined) {
      await this.grantWrite(existing.id);
      return { datasetId: existing.id, derived: false };
    }

    const copy = await this.deriveDataset(dataset.id, { name: `${dataset.name} working copy` });
    await this.grantWrite(copy.datasetId);
    return { datasetId: copy.datasetId, derived: true };
  }

  async grantWrite(datasetId: string): Promise<void> {
    const dataset = await this.getDataset(datasetId);
    if (dataset.kind === 'connected') {
      throw new DateraError(
        'WRITE_NOT_PERMITTED',
        `"${dataset.name}" reads your sources directly, and Datera never writes to a source (§1.2). ` +
          `Derive a working copy first — writes land there, and the originals stay untouched.`,
        { datasetId, kind: dataset.kind },
      );
    }
    await grantWriteIn(this.engine, datasetId, this.ports.clock.now().toISOString());
    this.ports.logger.log('warn', 'Write grant enabled', { datasetId, dataset: dataset.name });
  }

  async revokeWrite(datasetId: string): Promise<void> {
    await this.getDataset(datasetId);
    await revokeWriteIn(this.engine, datasetId);
    this.ports.logger.log('info', 'Write grant revoked', { datasetId });
  }

  /**
   * Propose a write. Nothing is executed — this builds the preview the gate needs.
   */
  // ------------------------------------------- authored operations (§8, §3a)

  /**
   * Save a named, typed, parameterised statement and serve it as its own tool.
   *
   * Everything risky is decided here rather than at call time, because authoring happens
   * once with a human watching and calling happens repeatedly without one:
   *
   *  - the name must be usable as an MCP tool name and a URL segment;
   *  - the declared parameters and the statement's placeholders must agree exactly;
   *  - the statement must stay inside its dataset, checked with the same AST walk the
   *    query path uses;
   *  - the kind is **measured** from DuckDB's parser, never taken from the name. Someone
   *    naming a DELETE `create_order` does not get it treated as a read.
   */
  async createOperation(input: CreateOperationInput): Promise<AuthoredOperation> {
    const dataset = await this.getDataset(input.datasetId);
    assertOperationName(input.name);
    assertParametersMatch(input.sql, input.parameters);

    const existing = await this.catalog.listOperations(input.datasetId);
    if (existing.some((o) => o.name === input.name)) {
      throw new DateraError(
        'DUPLICATE_NAME',
        `An operation called "${input.name}" already exists in "${dataset.name}".`,
        { name: input.name, datasetId: input.datasetId },
      );
    }

    // Classified with the placeholders replaced by literals: DuckDB cannot parse `$name`,
    // and what is being asked is "what kind of statement is this", which the shape answers
    // regardless of the values.
    const probe = {
      sql: inlineArguments(
        { ...(input as unknown as AuthoredOperation), parameters: input.parameters },
        Object.fromEntries(input.parameters.map((p) => [p.name, sampleFor(p.type)])),
      ),
    };

    await this.engine.executeInternal(`SET search_path = ${quoteIdent(dataset.schemaName)}`);
    await assertWriteInDataset(
      this.engine.classificationConnection(), probe.sql, dataset.schemaName, dataset.name,
    );

    const classification = await this.engine
      .classificationConnection()
      .classify(probe.sql);
    const kinds = classification.statements.map((st) => st.kind);

    if (classification.statements.length !== 1) {
      throw new DateraError(
        'INVALID_ARGUMENT',
        'An operation is exactly one statement. Batching would make one call do two things, only one of which its name describes.',
        { statementCount: classification.statements.length },
      );
    }

    const writes = kinds.some((k) => k === 'UPDATE' || k === 'DELETE' || k === 'INSERT');
    // Anything not provably a read is treated as a write: it then goes through the confirm
    // gate, which is the safe direction to be wrong in.
    const reads = kinds.every((k) => k === 'SELECT' || k === 'EXPLAIN');

    const operation: AuthoredOperation = {
      id: this.makeId(),
      datasetId: input.datasetId,
      name: input.name,
      description: input.description,
      sql: input.sql,
      parameters: input.parameters,
      kind: writes || !reads ? 'write' : 'read',
      createdAt: this.ports.clock.now().toISOString(),
    };

    await this.catalog.insertOperation(operation);
    this.ports.logger.log('info', 'Operation authored', {
      name: operation.name, kind: operation.kind, datasetId: operation.datasetId,
    });
    return operation;
  }

  async listOperations(datasetId?: string): Promise<readonly AuthoredOperation[]> {
    return this.catalog.listOperations(datasetId);
  }

  async deleteOperation(id: string): Promise<void> {
    await this.catalog.deleteOperation(id);
  }

  /**
   * Call an authored operation.
   *
   * A read runs and returns rows. A write **proposes** and returns the proposal — §6 says
   * a write is never executed without an explicit confirm, and an agent cannot confirm.
   * The caller ratifies with `confirmWrite`, exactly as they would for any other proposed
   * change; there is no second, quieter path to modifying data.
   */
  async callOperation(
    datasetId: string,
    name: string,
    args: Readonly<Record<string, unknown>> = {},
  ): Promise<OperationResult> {
    const operations = await this.catalog.listOperations(datasetId);
    const operation = operations.find((o) => o.name === name);
    if (operation === undefined) {
      throw new DateraError('INVALID_ARGUMENT', `No operation called "${name}" in this dataset.`, {
        name, datasetId,
      });
    }

    if (operation.kind === 'write') {
      // Escaped rather than bound — see inlineArguments for why the write preview makes
      // that the safer choice. The statement then goes through the ordinary write path,
      // gate included.
      return {
        kind: 'write',
        proposal: await this.proposeWrite(datasetId, inlineArguments(operation, args)),
      };
    }

    const bound = bindArguments(operation, args);
    const result = await this.query(datasetId, bound.sql, bound.values);
    return { kind: 'read', columns: result.columns.map((c) => c.name), rows: result.rows };
  }

  async proposeWrite(datasetId: string, sql: string): Promise<WriteProposal> {
    const dataset = await this.getDataset(datasetId);

    if (!(await isGranted(this.engine, datasetId))) {
      throw new DateraError(
        'WRITE_NOT_PERMITTED',
        `Writes are not enabled on "${dataset.name}". They are off by default and must be granted per dataset (§6).`,
        { datasetId },
      );
    }

    // search_path first: classification binds the statement, so `UPDATE orders` cannot be
    // recognised until `orders` resolves.
    await this.engine.executeInternal(`SET search_path = ${quoteIdent(dataset.schemaName)}`);

    // Boundary before classification: "this reaches outside the dataset" is both more
    // specific and more actionable than "that could not be bound", and a cross-dataset
    // write usually cannot bind anyway — so classifying first buries the real complaint.
    await assertWriteInDataset(this.engine.classificationConnection(), sql, dataset.schemaName, dataset.name);
    const kind = await classifyWrite(this.engine.classificationConnection(), sql);

    const preview = await previewWrite({
      engine: this.engine,
      schemaName: dataset.schemaName,
      sql,
      kind,
    });

    const proposal: WriteProposal = {
      id: this.makeId(),
      datasetId,
      sql,
      statementKind: kind,
      table: preview.table,
      rowsAffected: preview.rowsAffected,
      changes: preview.changes,
      warnings: preview.warnings,
      proposedAt: this.ports.clock.now().toISOString(),
    };

    this.pendingWrites.set(proposal.id, proposal);
    this.ports.logger.log('info', 'Write proposed (not executed)', {
      datasetId, kind, rowsAffected: preview.rowsAffected,
    });
    return proposal;
  }

  /**
   * Turn a question into a proposed write.
   *
   * §6's footgun: "an NL/agent DELETE from a fuzzy instruction". The model writes the SQL
   * and Datera previews it — the answer to the footgun is not to refuse the capability but
   * to make the consequence visible before it happens.
   */
  async proposeWriteFromQuestion(datasetId: string, instruction: string): Promise<WriteProposal> {
    const dataset = await this.getDataset(datasetId);

    if (!(await isGranted(this.engine, datasetId))) {
      throw new DateraError(
        'WRITE_NOT_PERMITTED',
        `Writes are not enabled on "${dataset.name}".`,
        { datasetId },
      );
    }

    const model = await this.chatModel();
    if (model === null) {
      throw new DateraError('MODEL_UNAVAILABLE', 'No chat model is configured.', { datasetId });
    }

    const schemas = await this.datasetSchemas(datasetId, dataset.schemaName);
    const trace = new TraceBuilder(
      this.makeId(), datasetId, instruction,
      this.ports.clock.now().toISOString(), () => this.ports.clock.monotonicMs(),
    );

    const schemaContext = buildSchemaContext(schemas);
    trace.add({ kind: 'schema', label: 'Schema given to the model', detail: schemaContext });

    const system = [
      'You translate an instruction into a single DuckDB UPDATE, DELETE or INSERT statement.',
      'Return ONLY SQL. Exactly one statement. Never a SELECT.',
      'Use only the tables and columns given. Never invent a column.',
    ].join('\n');
    const user = `Tables:\n\n${schemaContext}\n\nInstruction: ${instruction}\n\nSQL:`;

    const response = await model.chat({
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
    });

    const extracted = extractSql(response.text);
    if (extracted.sql === null) {
      throw new DateraError(
        'CANNOT_ANSWER',
        `The model did not produce a statement for that instruction. ${extracted.cannotAnswer ?? ''}`.trim(),
        { datasetId, instruction },
      );
    }

    trace.add({ kind: 'sql', label: 'Proposed SQL', sql: extracted.sql, detail: 'Shown before anything runs.' });

    let proposal: WriteProposal;
    try {
      proposal = await this.proposeWrite(datasetId, extracted.sql);
    } catch (e) {
      // A model that invents a column is the characteristic failure, and it arrives here
      // as a binder error. Ask already reports this as "could not answer"; the write path
      // used to surface the raw parser output instead, so the same mistake produced two
      // completely different experiences. Found by running against a real model.
      if (DateraError.is(e, 'INVALID_ARGUMENT') && e.details['bindError'] !== undefined) {
        throw new DateraError(
          'CANNOT_ANSWER',
          `Datera will not propose that change: the model's SQL refers to ${describeMissing(String(e.details['bindError']))}, ` +
            `which does not exist in this dataset. Rephrase, or check the Dictionary so the model knows what your columns mean.`,
          { datasetId, instruction, sql: extracted.sql, bindError: e.details['bindError'] },
        );
      }
      throw e;
    }
    const withTrace: WriteProposal = { ...proposal, trace: trace.build('structured', true) };
    this.pendingWrites.set(proposal.id, withTrace);
    return withTrace;
  }

  /** Execute a proposal. The only path that changes data. */
  async confirmWrite(proposalId: string): Promise<AppliedWrite> {
    const proposal = this.pendingWrites.get(proposalId);
    if (proposal === undefined) {
      throw new DateraError(
        'INVALID_ARGUMENT',
        'That proposal is not pending — it may already have been confirmed, or this is a new session.',
        { proposalId },
      );
    }

    const dataset = await this.getDataset(proposal.datasetId);

    // Re-checked at confirm time, not just at propose time: a grant revoked in between
    // must take effect, or "revocable" would mean "revocable for future proposals".
    if (!(await isGranted(this.engine, proposal.datasetId))) {
      throw new DateraError(
        'WRITE_NOT_PERMITTED',
        `Writes were disabled on "${dataset.name}" after this was proposed, so it was not applied.`,
        { proposalId, datasetId: proposal.datasetId },
      );
    }

    const undoSchema = `_undo_${dataset.schemaName}`;
    const undoTable = `${proposal.table}_${proposal.id.replace(/[^\w]/g, '')}`;

    const delta = await applyWrite({
      engine: this.engine,
      schemaName: dataset.schemaName,
      undoSchema,
      undoTable,
      table: proposal.table,
      sql: proposal.sql,
    });

    const rowsChanged = proposal.statementKind === 'UPDATE' ? proposal.rowsAffected : delta;
    const applied: AppliedWrite = {
      id: this.makeId(),
      datasetId: proposal.datasetId,
      sql: proposal.sql,
      rowsChanged,
      confirmedAt: this.ports.clock.now().toISOString(),
      undoneAt: null,
    };

    await this.engine.executeInternal(
      `INSERT INTO _datera.write_log
        (id, dataset_id, sql, rows_changed, undo_schema, undo_table, target_table, confirmed_at, undone_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      [applied.id, applied.datasetId, applied.sql, rowsChanged, undoSchema, undoTable, proposal.table, applied.confirmedAt],
    );

    this.pendingWrites.delete(proposalId);
    this.ports.logger.log('warn', 'Write applied', {
      datasetId: proposal.datasetId, kind: proposal.statementKind, rowsChanged,
    });
    return applied;
  }

  /** Revert a confirmed write from its snapshot. */
  async undoWrite(writeId: string): Promise<void> {
    const result = await this.engine.executeInternal(
      `SELECT dataset_id, undo_schema, undo_table, target_table, undone_at
       FROM _datera.write_log WHERE id = ?`,
      [writeId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new DateraError('INVALID_ARGUMENT', `No write with id "${writeId}"`, { writeId });
    }
    if (row[4] !== null) {
      throw new DateraError('INVALID_ARGUMENT', 'That write has already been undone.', { writeId });
    }

    const dataset = await this.getDataset(String(row[0]));
    await restore({
      engine: this.engine,
      schemaName: dataset.schemaName,
      undoSchema: String(row[1]),
      undoTable: String(row[2]),
      table: String(row[3]),
    });

    await this.engine.executeInternal(`UPDATE _datera.write_log SET undone_at = ? WHERE id = ?`, [
      this.ports.clock.now().toISOString(),
      writeId,
    ]);
    this.ports.logger.log('warn', 'Write undone', { writeId });
  }

  /** The audit log of applied writes (§6). */
  async listWrites(datasetId: string): Promise<readonly AppliedWrite[]> {
    await this.getDataset(datasetId);
    const result = await this.engine.executeInternal(
      `SELECT id, dataset_id, sql, rows_changed, confirmed_at, undone_at
       FROM _datera.write_log WHERE dataset_id = ? ORDER BY confirmed_at`,
      [datasetId],
    );
    return result.rows.map((row) => ({
      id: String(row[0]),
      datasetId: String(row[1]),
      sql: String(row[2]),
      rowsChanged: Number(row[3]),
      confirmedAt: String(row[4]),
      undoneAt: row[5] === null ? null : String(row[5]),
    }));
  }

  // ------------------------------------------------------------- serve (§8)

  /**
   * The tools an agent can call.
   *
   * Generated from the datasets that exist right now, and deliberately conditional: a
   * search tool appears only where something is embedded, and a mutation tool only where
   * writes are granted. Advertising a tool that will fail is worse than omitting it — the
   * agent has already committed to a plan by the time it finds out.
   */
  async listTools(): Promise<readonly ToolDefinition[]> {
    const datasets = await this.catalog.listDatasets();
    const contexts: ToolContext[] = [];

    for (const dataset of datasets) {
      contexts.push({
        dataset,
        hasEmbeddings: (await embeddedColumns(this.engine, dataset.id)).length > 0,
        canWrite: await isGranted(this.engine, dataset.id),
      });
    }

    const generated = toolsFor(contexts);

    // Authored operations, appended. A write operation is offered only where its dataset
    // has a grant — the same rule the generated propose tool follows, because Datera does
    // not advertise a tool that would fail when called.
    const writable = new Set(contexts.filter((c) => c.canWrite).map((c) => c.dataset.id));
    const authored = (await this.catalog.listOperations())
      .filter((o) => o.kind === 'read' || writable.has(o.datasetId))
      .map(operationTool);

    return [...generated, ...authored];
  }

  /**
   * Execute a tool call, producing the end-to-end trace §12.9 requires.
   *
   * Every guard that protects the UI protects this: read-only, the dataset boundary, and
   * the write gate. A request arriving over MCP is not trusted more than one typed into
   * the SQL editor.
   */
  async callTool(name: string, args: Readonly<Record<string, unknown>>): Promise<ToolResult> {
    const trace = new TraceBuilder(
      this.makeId(), 'unknown', name,
      this.ports.clock.now().toISOString(), () => this.ports.clock.monotonicMs(),
    );
    trace.add({ kind: 'parse', label: 'Tool call received', detail: `${name}(${Object.keys(args).join(', ')})` });

    const fail = async (message: string, datasetId = 'unknown'): Promise<ToolResult> => {
      const built = trace.build('structured', false);
      await this.record(built, { origin: 'tool', rowsReturned: 0, ok: false, error: message });
      void datasetId;
      return { content: [{ type: 'text', text: message }], isError: true, trace: built };
    };

    const datasets = await this.catalog.listDatasets();

    // Authored operations are checked first: a workspace's own named operation should win
    // over anything generated, and its name cannot collide with one (the generated names
    // all carry a `query_`/`search_`/`propose_write_` prefix or are `describe_schema`).
    const operation = (await this.catalog.listOperations()).find((o) => o.name === name);
    if (operation !== undefined) {
      trace.add({ kind: 'route', label: 'Authored operation', detail: `${operation.name} (${operation.kind})` });
      try {
        const result = await this.callOperation(operation.datasetId, operation.name, args);
        const built = trace.build('structured', true);
        await this.record(built, { origin: 'tool', rowsReturned: result.rows?.length ?? 0, ok: true });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          isError: false,
          trace: built,
        };
      } catch (e) {
        return fail((e as { message?: string }).message ?? String(e), operation.datasetId);
      }
    }

    if (name === 'describe_schema') {
      const datasetId = typeof args['dataset'] === 'string' ? args['dataset'] : DEFAULT_DATASET_ID;
      const dataset = datasets.find((d) => d.id === datasetId);
      if (dataset === undefined) return fail(`Unknown dataset "${datasetId}".`);

      const schemas = await this.datasetSchemas(dataset.id, dataset.schemaName);
      const dictionaries: SourceDictionary[] = [];
      for (const source of (await this.listSources()).filter((s) => s.datasetId === dataset.id)) {
        dictionaries.push(await this.getDictionary(source.id));
      }

      // Only this dataset's schema, exactly as §12.4 requires for the model — an agent
      // gets no broader a view than the NL path does.
      const text = buildSchemaContext(schemas, { dictionaries });
      trace.add({ kind: 'schema', label: 'Schema described', detail: text });

      const built = trace.build('structured', true);
      await this.record(built, { origin: 'tool', rowsReturned: schemas.length, ok: true });
      return { content: [{ type: 'text', text }], isError: false, trace: built };
    }

    const dataset = datasets.find((d) => name.endsWith(`_${toolSuffix(d)}`));
    if (dataset === undefined) return fail(`Unknown tool "${name}".`);

    if (name.startsWith('query_')) {
      const sql = typeof args['sql'] === 'string' ? args['sql'] : '';
      if (sql.length === 0) return fail('The `sql` argument is required.');

      try {
        const result = await this.query(dataset.id, sql);
        trace.add({ kind: 'guard', label: 'Read-only check', detail: 'Passed.' });
        trace.add({ kind: 'execute', label: 'Ran locally', rowCount: result.rows.length });

        const built = trace.build('structured', true);
        await this.record(built, { origin: 'tool', rowsReturned: result.rows.length, ok: true });

        return {
          content: [{ type: 'text', text: JSON.stringify({ columns: result.columns, rows: result.rows }) }],
          isError: false,
          trace: built,
        };
      } catch (e) {
        trace.add({ kind: 'guard', label: 'Refused', detail: e instanceof Error ? e.message : String(e) });
        return fail(e instanceof Error ? e.message : String(e), dataset.id);
      }
    }

    if (name.startsWith('search_')) {
      const text = typeof args['text'] === 'string' ? args['text'] : '';
      if (text.length === 0) return fail('The `text` argument is required.');
      const k = typeof args['k'] === 'number' ? args['k'] : 5;

      const hits = await this.semanticSearch(dataset.id, text, k);
      trace.add({ kind: 'retrieve', label: 'Closest matches', rowCount: hits.length });

      const built = trace.build('semantic', true);
      await this.record(built, { origin: 'tool', rowsReturned: hits.length, ok: true });
      return { content: [{ type: 'text', text: JSON.stringify(hits) }], isError: false, trace: built };
    }

    if (name.startsWith('propose_write_')) {
      const instruction = typeof args['instruction'] === 'string' ? args['instruction'] : '';
      if (instruction.length === 0) return fail('The `instruction` argument is required.');

      try {
        // Proposes. Does not apply. §6 is explicit that an agent-proposed mutation must
        // surface for human approval, so there is no tool that confirms one.
        const proposal = /^\s*(update|delete|insert)\b/i.test(instruction)
          ? await this.proposeWrite(dataset.id, instruction)
          : await this.proposeWriteFromQuestion(dataset.id, instruction);

        const built = trace.build('structured', true);
        await this.record(built, { origin: 'tool', rowsReturned: proposal.rowsAffected, ok: true });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                proposed: true,
                applied: false,
                note: 'This has NOT been executed. A human must confirm it in Datera.',
                sql: proposal.sql,
                rowsAffected: proposal.rowsAffected,
                warnings: proposal.warnings,
                changes: proposal.changes.slice(0, 5),
              }),
            },
          ],
          isError: false,
          trace: built,
        };
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e), dataset.id);
      }
    }

    return fail(`Unknown tool "${name}".`);
  }

  /** Per-client connect configuration (§8). */
  async connectConfig(
    client: ClientId,
    options: { readonly url?: string; readonly token?: string } = {},
  ): Promise<ConnectConfig> {
    const config: ConfigOptions = {
      workspacePath: this.paths.root,
      ...(options.url === undefined ? {} : { url: options.url }),
      ...(options.token === undefined ? {} : { token: options.token }),
    };
    return buildConnectConfig(client, config);
  }

  // ---------------------------------------------------- the trace log (§8a)

  async setTracePayloadCapture(enabled: boolean): Promise<void> {
    await this.catalog.setSetting(TRACE_PAYLOADS_SETTING, enabled ? 'true' : 'false');
    this.ports.logger.log('warn', 'Trace payload capture changed', { enabled });
  }

  async getTracePayloadCapture(): Promise<boolean> {
    return (await this.catalog.getSetting(TRACE_PAYLOADS_SETTING)) === 'true';
  }

  async setTraceRetention(policy: Partial<RetentionPolicy>): Promise<RetentionPolicy> {
    const next = { ...(await this.getTraceRetention()), ...policy };
    await this.catalog.setSetting(TRACE_RETENTION_SETTING, JSON.stringify(next));
    return next;
  }

  async getTraceRetention(): Promise<RetentionPolicy> {
    const raw = await this.catalog.getSetting(TRACE_RETENTION_SETTING);
    if (raw === null) return DEFAULT_RETENTION;
    try {
      return { ...DEFAULT_RETENTION, ...(JSON.parse(raw) as Partial<RetentionPolicy>) };
    } catch {
      return DEFAULT_RETENTION;
    }
  }

  async queryTraceLog(query: TraceQuery): Promise<readonly TraceRecord[]> {
    return runTraceQuery(this.engine, query);
  }

  async pruneTraceLog(): Promise<number> {
    return prune(this.engine, await this.getTraceRetention(), this.ports.clock.now());
  }

  /** Persist one trace. Called on every request path, so it is deliberately forgiving. */
  private async record(
    trace: Trace,
    options: { origin: TraceOrigin; rowsReturned: number; ok: boolean; error?: string },
  ): Promise<void> {
    try {
      const secrets: (string | null)[] = [];
      for (const provider of ['anthropic', 'openai']) {
        secrets.push(await this.ports.secrets.get(apiKeySecretName(provider)));
      }

      await recordTrace(this.engine, trace, {
        origin: options.origin,
        rowsReturned: options.rowsReturned,
        ok: options.ok,
        error: options.error ?? null,
        capturePayloads: await this.getTracePayloadCapture(),
        secrets,
      });
    } catch (e) {
      // Failing to write the audit record must not fail the request it describes. It is
      // logged loudly instead, because a silently missing audit trail is its own problem.
      this.ports.logger.log('error', 'Could not persist trace record', {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // ------------------------------------------------ environments (§10, §12.10)

  /**
   * Environments the client can drive.
   *
   * Local always exists and is always first: Datera works standalone, and a list that
   * could be empty would imply otherwise.
   */
  async listEnvironments(): Promise<readonly Environment[]> {
    const local: Environment = {
      id: LOCAL_ENVIRONMENT_ID,
      name: 'Local',
      kind: 'local',
      createdAt: this.manifest.createdAt,
    };

    const raw = await this.catalog.getSetting(ENVIRONMENTS_SETTING);
    if (raw === null) return [local];

    try {
      const stored = JSON.parse(raw) as Environment[];
      return [local, ...stored.filter((e) => e.id !== LOCAL_ENVIRONMENT_ID)];
    } catch {
      return [local];
    }
  }

  /** Add a deployed Datera Server. The token goes to the keychain, never to the catalog. */
  async addEnvironment(input: {
    readonly id: string;
    readonly name: string;
    readonly url: string;
    readonly token?: string;
  }): Promise<Environment> {
    if (input.id === LOCAL_ENVIRONMENT_ID) {
      throw new DateraError('INVALID_ARGUMENT', '"local" is reserved for this machine.', {});
    }

    let tokenKey: string | undefined;
    if (input.token !== undefined && input.token.length > 0) {
      if (!(await this.ports.secrets.isAvailable())) {
        throw new DateraError(
          'SECRET_STORE_UNAVAILABLE',
          'No protected credential store is available, and Datera will not write an environment token to disk in plaintext.',
          { environment: input.id },
        );
      }
      tokenKey = environmentTokenKey(input.id);
      await this.ports.secrets.set(tokenKey, input.token);
    }

    const environment: Environment = {
      id: input.id,
      name: input.name,
      kind: 'remote',
      url: input.url.replace(/\/+$/, ''),
      tokenKey,
      createdAt: this.ports.clock.now().toISOString(),
    };

    const existing = (await this.listEnvironments()).filter(
      (e) => e.kind === 'remote' && e.id !== input.id,
    );
    await this.catalog.setSetting(ENVIRONMENTS_SETTING, JSON.stringify([...existing, environment]));

    this.ports.logger.log('info', 'Environment added', { id: input.id, url: environment.url });
    return environment;
  }

  async removeEnvironment(id: string): Promise<void> {
    if (id === LOCAL_ENVIRONMENT_ID) {
      throw new DateraError(
        'INVALID_ARGUMENT',
        'The local environment cannot be removed — Datera always has somewhere to work.',
        {},
      );
    }
    const remaining = (await this.listEnvironments()).filter((e) => e.kind === 'remote' && e.id !== id);
    await this.catalog.setSetting(ENVIRONMENTS_SETTING, JSON.stringify(remaining));
    await this.ports.secrets.delete(environmentTokenKey(id));
  }

  /** A client for a remote environment, offering the same operations as the local façade. */
  async connectTo(environmentId: string): Promise<RemoteDatera> {
    const environment = (await this.listEnvironments()).find((e) => e.id === environmentId);
    if (environment === undefined || environment.kind !== 'remote' || environment.url === undefined) {
      throw new DateraError(
        'INVALID_ARGUMENT',
        `"${environmentId}" is not a remote environment.`,
        { environmentId },
      );
    }

    const token =
      environment.tokenKey === undefined ? null : await this.ports.secrets.get(environment.tokenKey);

    return new RemoteDatera(this.http, environment.url, token, environment.name);
  }

  /** Reachability for the environment list. Never throws — the UI wants a badge. */
  /**
   * Every dataset reachable from here — this machine's, and any server's (§12.10).
   *
   * §12.10 says the same UI drives a Datera Server. That has been true of the *interface*
   * for a while and false of the product: the client could push to a server and check it
   * was up, but never query one, so a remote dataset was somewhere you sent data rather
   * than somewhere you worked.
   *
   * An unreachable environment contributes nothing and does not throw. A server being
   * down is a normal condition, not an error in listing what is available.
   */
  async listReachableDatasets(): Promise<readonly ReachableDataset[]> {
    const local = (await this.listDatasets()).map((dataset) => ({
      environmentId: 'local',
      environmentName: 'This machine',
      dataset,
      remote: false,
    }));

    const remote: ReachableDataset[] = [];
    for (const environment of await this.listEnvironments()) {
      if (environment.kind === 'local') continue;
      try {
        const client = await this.connectTo(environment.id);
        for (const dataset of await client.listDatasets()) {
          remote.push({
            environmentId: environment.id,
            environmentName: environment.name,
            dataset,
            remote: true,
          });
        }
      } catch {
        // Unreachable. Listing what is available should not fail because one server is
        // down — the Environments view is where that is reported.
      }
    }

    return [...local, ...remote];
  }

  async environmentStatuses(): Promise<readonly EnvironmentStatus[]> {
    const environments = await this.listEnvironments();
    const statuses: EnvironmentStatus[] = [];

    for (const environment of environments) {
      if (environment.kind === 'local') {
        statuses.push({
          id: environment.id, name: environment.name, kind: 'local',
          url: null, reachable: true,
        });
        continue;
      }

      const client = await this.connectTo(environment.id);
      const health = await client.reachable();
      statuses.push({
        id: environment.id,
        name: environment.name,
        kind: 'remote',
        url: environment.url ?? null,
        reachable: health.ok,
        ...(health.reason === undefined ? {} : { reason: health.reason }),
      });
    }

    return statuses;
  }

  /**
   * Push a dataset to an environment (spec §10).
   *
   * Reuses the §12.11 export, deliberately: a push that serialised data its own way could
   * be lossy in ways an export is not, and then "what you pushed" and "what you can take
   * away" would be two different things.
   */
  async pushDataset(
    datasetId: string,
    environmentId: string,
  ): Promise<{ ok: true; environment: string }> {
    if (environmentId === LOCAL_ENVIRONMENT_ID) {
      throw new DateraError(
        'INVALID_ARGUMENT',
        'That dataset is already here. Push targets a deployed Datera Server.',
        { datasetId },
      );
    }

    const dataset = await this.getDataset(datasetId);
    const client = await this.connectTo(environmentId);

    const dictionaries: SourceDictionary[] = [];
    for (const source of (await this.listSources()).filter((s) => s.datasetId === datasetId)) {
      dictionaries.push(await this.getDictionary(source.id));
    }

    const manifest = await this.buildPushManifest(dataset, dictionaries, datasetId);
    await client.push(manifest.manifest, manifest.tables);

    this.ports.logger.log('info', 'Dataset pushed', { datasetId, environmentId });
    return { ok: true, environment: environmentId };
  }

  /**
   * Accept a pushed dataset. Called by a host that has chosen to allow pushes.
   *
   * Note what this does *not* do: it performs no authorisation. Deciding whether a caller
   * may push is the host's job — and on a real Datera Server that decision involves
   * per-token scoping, which is private-repo code by §2.
   */
  async receivePush(
    manifestJson: string,
    tables: readonly { name: string; csv: string }[],
  ): Promise<{ datasetId: string; tables: readonly string[] }> {
    const manifest = JSON.parse(manifestJson) as { dataset: { name: string; description: string } };

    const schemaName = await this.uniqueSchemaName(manifest.dataset.name);
    const dataset: Dataset = {
      id: this.makeId(),
      name: manifest.dataset.name,
      description: manifest.dataset.description,
      schemaName,
      isDefault: false,
      kind: 'imported',
      createdAt: this.ports.clock.now().toISOString(),
    };

    await this.engine.executeInternal(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schemaName)}`);
    await this.catalog.insertDataset(dataset);

    // A push carries CSV *content*, and DuckDB's readers take paths. Staging it in the
    // workspace keeps one CSV parser in play — the same sniffer, the same type inference,
    // the same warnings a connected file gets — rather than a second, divergent path for
    // data that arrived over the wire.
    const inbox = joinPath(this.paths.root, '.push-inbox');
    await this.ports.fs.mkdirp(inbox);

    const created: string[] = [];
    for (const table of tables) {
      const staged = joinPath(inbox, `${table.name}.csv`);
      await this.ports.fs.writeTextFile(staged, table.csv);

      await this.engine.executeInternal(
        `CREATE TABLE ${qualified(schemaName, table.name)} AS
         SELECT * FROM read_csv(${quoteLiteral(staged)}, auto_detect=true)`,
      );
      created.push(table.name);

      const source: Source = {
        id: this.makeId(),
        datasetId: dataset.id,
        name: table.name,
        kind: 'csv',
        origin: staged,
        detection: { method: 'received from a Datera client push', settings: {} },
        addedAt: this.ports.clock.now().toISOString(),
      };
      await this.catalog.insertSource(source);

      const parsed = JSON.parse(manifestJson) as { dictionaries?: SourceDictionary[] };
      const dictionary = (parsed.dictionaries ?? []).find((d) => d.sourceName === table.name);
      for (const column of dictionary?.columns ?? []) {
        if (column.state === 'undefined') continue;
        await this.catalog.upsertColumnDefinition(source.id, column);
      }
      if (dictionary !== undefined && dictionary.entity.state !== 'undefined') {
        await this.catalog.upsertEntityDefinition(source.id, dictionary.entity);
      }
    }

    return { datasetId: dataset.id, tables: created };
  }

  /** Export into a temporary directory and read back the pieces a push carries. */
  private async buildPushManifest(
    dataset: Dataset,
    dictionaries: readonly SourceDictionary[],
    datasetId: string,
  ): Promise<{ manifest: string; tables: { name: string; csv: string }[] }> {
    const directory = joinPath(this.paths.root, '.push-staging');
    const exported = await runExportDataset({
      engine: this.engine,
      fs: this.ports.fs,
      dataset,
      directory,
      format: 'csv',
      dictionaries,
      relationships: await this.catalog.listRelationships(datasetId),
      now: () => this.ports.clock.now(),
      appVersion: this.manifest.createdBy,
    });

    const tables: { name: string; csv: string }[] = [];
    for (const table of exported.manifest.tables) {
      tables.push({
        name: table.name,
        csv: await this.ports.fs.readTextFile(joinPath(directory, table.file)),
      });
    }

    return { manifest: JSON.stringify(exported.manifest), tables };
  }

  // ------------------------------------------------------ teaching (§11.9)

  /**
   * The lifecycle to show: authored if one exists, otherwise derived from the connected
   * data, otherwise the shipped example.
   *
   * Deriving is the default because a teaching tool that explains a generic `revenue`
   * column while the user is looking at their own table is teaching the concept and not
   * the data — and the data is the part they came for.
   */
  async getLifecycle(): Promise<Lifecycle> {
    const raw = await this.catalog.getSetting(LIFECYCLE_SETTING);
    if (raw !== null) {
      try {
        return { source: 'curated', grounding: 'authored', ...(JSON.parse(raw) as Lifecycle) };
      } catch {
        // A corrupt stored lifecycle falls through to a derived one rather than failing.
      }
    }
    return this.derivedLifecycle();
  }

  private async derivedLifecycle(): Promise<Lifecycle> {
    const sources = (await this.listSources()).filter((s) => s.status.availability === 'available');
    if (sources.length === 0) return { ...DEFAULT_LIFECYCLE, grounding: 'generic' };

    const schemas: SourceSchema[] = [];
    const dictionaries: SourceDictionary[] = [];
    for (const source of sources) {
      const dataset = await this.getDataset(source.datasetId);
      schemas.push(await introspectSource(this.engine, source, dataset.schemaName));
      dictionaries.push(await this.getDictionary(source.id));
    }

    // A real value from the data, so the walkthrough shows a number the user recognises
    // rather than one Datera made up.
    const sample = await this.sampleForLifecycle(schemas, sources);
    return deriveLifecycle(schemas, dictionaries, sample);
  }

  private async sampleForLifecycle(
    schemas: readonly SourceSchema[],
    sources: readonly SourceWithStatus[],
  ): Promise<{ column: string; value: string } | null> {
    for (const schema of schemas) {
      const money = schema.columns.find((c) => /_(cents|cent|pence|minor)$/i.test(c.name));
      if (money === undefined) continue;

      const source = sources.find((s) => s.name === schema.sourceName);
      if (source === undefined) continue;
      const dataset = await this.getDataset(source.datasetId);

      try {
        const result = await this.engine.executeInternal(
          `SELECT CAST(${quoteIdent(money.name)} AS VARCHAR) FROM ${qualified(dataset.schemaName, schema.sourceName)}
           WHERE ${quoteIdent(money.name)} IS NOT NULL LIMIT 1`,
        );
        const value = result.rows[0]?.[0];
        if (typeof value === 'string') return { column: money.name, value };
      } catch {
        // Fall through to the derived default.
      }
    }
    return null;
  }

  /**
   * Define a lifecycle. This is the "authorable without a code change" criterion —
   * an instructor writes their own and it takes effect immediately.
   */
  async setLifecycle(lifecycle: Lifecycle): Promise<void> {
    validateLifecycle(lifecycle);
    await this.catalog.setSetting(
      LIFECYCLE_SETTING,
      JSON.stringify({ ...lifecycle, source: 'curated' }),
    );
  }

  /** Forget an authored lifecycle, falling back to the one derived from the data. */
  async resetLifecycle(): Promise<void> {
    await this.catalog.setSetting(LIFECYCLE_SETTING, '');
    await this.engine.executeInternal(`DELETE FROM _datera.settings WHERE key = ?`, [LIFECYCLE_SETTING]);
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
      kind: 'connected',
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
  /**
   * The dataset's shape in one structure: tables, columns, confirmed meanings, confirmed
   * relationships.
   *
   * Deliberately filtered the same way the model context is (§1.4): a column the user
   * marked sensitive is withheld here too, with only a count left behind. A picker that
   * advertised a column the model is not allowed to see would leak the name the hiding
   * was meant to protect, and would offer a completion that produces a query the user
   * then has to explain to themselves.
   */
  async schemaGraph(datasetId: string): Promise<SchemaGraph> {
    const dataset = await this.getDataset(datasetId);
    const schemas = await this.datasetSchemas(datasetId, dataset.schemaName);
    const relationships = await this.listRelationships(datasetId);

    const keyed = new Set<string>();
    for (const r of relationships) {
      keyed.add(`${r.fromTable}.${r.fromColumn}`.toLowerCase());
      keyed.add(`${r.toTable}.${r.toColumn}`.toLowerCase());
    }

    const tables: GraphTable[] = [];
    for (const schema of schemas) {
      const definitions = schema.sourceId === null
        ? new Map<string, ColumnDefinition>()
        : new Map(
            confirmedOnly(await this.getDictionary(schema.sourceId)).columns.map((c) => [c.column, c]),
          );

      const visible = schema.columns.filter((c) => definitions.get(c.name)?.sensitivity !== 'hidden');

      tables.push({
        name: schema.sourceName,
        rowCount: schema.rowCount,
        hiddenColumns: schema.columns.length - visible.length,
        columns: visible.map((c) => ({
          name: c.name,
          type: c.type,
          isKey: keyed.has(`${schema.sourceName}.${c.name}`.toLowerCase()),
          nullCount: c.nullCount,
          meaning: definitions.get(c.name)?.meaning ?? '',
        })),
      });
    }

    return {
      datasetId,
      tables,
      relationships: relationships.map((r) => ({
        fromTable: r.fromTable,
        fromColumn: r.fromColumn,
        toTable: r.toTable,
        toColumn: r.toColumn,
      })),
    };
  }

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
