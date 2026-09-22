import { asDateraError, DateraError } from '../errors.js';
import type { Engine } from '../engine/engine.js';
import type { Source, SourceDetection, SourceKind } from '../sources/types.js';
import type { Dataset } from '../datasets/types.js';
import type { AuthoredRelationship } from '../datasets/authoring.js';
import type { ColumnDefinition, EntityDefinition } from '../dictionary/types.js';
import type { AuthoredOperation } from '../serve/operations.js';

export const CATALOG_SCHEMA = '_datera';


/**
 * Datera's own bookkeeping, stored inside workspace.duckdb.
 *
 * It lives in a `_datera` schema rather than `main` so that a dataset schema never
 * collides with it and a user browsing their workspace can tell instantly which objects
 * are theirs and which are Datera's.
 */
export class Catalog {
  constructor(private readonly engine: Engine) {}

  async migrate(): Promise<void> {
    await this.engine.executeInternal(`CREATE SCHEMA IF NOT EXISTS ${CATALOG_SCHEMA}`);
    await this.engine.executeInternal(`
      CREATE TABLE IF NOT EXISTS ${CATALOG_SCHEMA}.datasets (
        id VARCHAR PRIMARY KEY,
        name VARCHAR NOT NULL,
        description VARCHAR NOT NULL DEFAULT '',
        schema_name VARCHAR NOT NULL,
        is_default BOOLEAN NOT NULL DEFAULT false,
        created_at VARCHAR NOT NULL,
        kind VARCHAR NOT NULL DEFAULT 'connected',
        derived_from VARCHAR
      )`);
    // Workspaces created before Phase 5 have a datasets table without these columns.
    await this.addMissingColumns('datasets', [
      // No NOT NULL: DuckDB rejects `ADD COLUMN ... NOT NULL` outright ("Adding columns
      // with constraints not yet supported"). Existing rows are backfilled below instead.
      { name: 'kind', type: "VARCHAR DEFAULT 'connected'", backfill: "'connected'" },
      { name: 'derived_from', type: 'VARCHAR' },
    ]);
    await this.engine.executeInternal(`
      CREATE TABLE IF NOT EXISTS ${CATALOG_SCHEMA}.sources (
        id VARCHAR PRIMARY KEY,
        dataset_id VARCHAR NOT NULL,
        name VARCHAR NOT NULL,
        kind VARCHAR NOT NULL,
        origin VARCHAR NOT NULL,
        table_name VARCHAR,
        attachment_alias VARCHAR,
        secret_key VARCHAR,
        detection_json VARCHAR NOT NULL,
        added_at VARCHAR NOT NULL
      )`);
    // Relationships live in Datera's catalog rather than as DuckDB foreign keys: a source
    // is a view over a file and cannot carry a constraint, and Phase 3 needs a
    // suggested/confirmed state that a constraint has nowhere to put (invariant §1.3).
    await this.engine.executeInternal(`
      CREATE TABLE IF NOT EXISTS ${CATALOG_SCHEMA}.relationships (
        id VARCHAR PRIMARY KEY,
        dataset_id VARCHAR NOT NULL,
        from_table VARCHAR NOT NULL,
        from_column VARCHAR NOT NULL,
        to_table VARCHAR NOT NULL,
        to_column VARCHAR NOT NULL,
        state VARCHAR NOT NULL,
        created_at VARCHAR NOT NULL
      )`);
    await this.engine.executeInternal(`
      CREATE TABLE IF NOT EXISTS ${CATALOG_SCHEMA}.settings (
        key VARCHAR PRIMARY KEY,
        value VARCHAR NOT NULL
      )`);
    // The dictionary (§4). Stored as JSON per item rather than as columns: definitions
    // grew twice during Phase 3 alone, and a migration per field is not worth it.
    await this.engine.executeInternal(`
      CREATE TABLE IF NOT EXISTS ${CATALOG_SCHEMA}.dictionary_columns (
        source_id VARCHAR NOT NULL,
        column_name VARCHAR NOT NULL,
        definition_json VARCHAR NOT NULL,
        PRIMARY KEY (source_id, column_name)
      )`);
    await this.engine.executeInternal(`
      CREATE TABLE IF NOT EXISTS ${CATALOG_SCHEMA}.dictionary_entities (
        source_id VARCHAR PRIMARY KEY,
        definition_json VARCHAR NOT NULL
      )`);
    // Authored operations (§8). Parameters as JSON for the same reason the dictionary is:
    // their shape has room to grow, and a migration per field is not worth it.
    await this.engine.executeInternal(`
      CREATE TABLE IF NOT EXISTS ${CATALOG_SCHEMA}.operations (
        id VARCHAR PRIMARY KEY,
        dataset_id VARCHAR NOT NULL,
        name VARCHAR NOT NULL,
        description VARCHAR NOT NULL,
        sql VARCHAR NOT NULL,
        parameters_json VARCHAR NOT NULL,
        kind VARCHAR NOT NULL,
        created_at VARCHAR NOT NULL
      )`);
  }

  /**
   * Add columns a workspace does not have yet.
   *
   * Two rules, both learned from a bug that reached a user and stopped Datera opening at
   * all on any workspace older than the release that introduced these columns:
   *
   *  1. **Ask what exists, do not guess.** The previous version issued an ALTER and caught
   *     the error on the assumption that a failure meant "already present". DuckDB was
   *     actually rejecting the statement for an unrelated reason, so the column was never
   *     added and the next SELECT failed with an incomprehensible binder error.
   *  2. **Never swallow a failure.** A migration that cannot do its job says so at startup,
   *     where the message can name the workspace — not later, from a query that has no idea
   *     why its column is missing.
   */
  private async addMissingColumns(
    table: string,
    columns: readonly { name: string; type: string; backfill?: string }[],
  ): Promise<void> {
    const existing = await this.engine.executeInternal(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = ? AND table_name = ?`,
      [CATALOG_SCHEMA, table],
    );
    const present = new Set(existing.rows.map((row) => String(row[0]).toLowerCase()));

    // An empty result means the table is not a real table — a view, say — in which case
    // ALTER cannot work and pretending otherwise just defers the failure.
    if (present.size === 0) {
      throw new DateraError(
        'WORKSPACE_FORMAT_UNSUPPORTED',
        `This workspace could not be upgraded: ${CATALOG_SCHEMA}.${table} is missing or is not a table. ` +
          `Datera will not continue with a half-migrated catalog.`,
        { table },
      );
    }

    for (const column of columns) {
      if (present.has(column.name.toLowerCase())) continue;

      try {
        await this.engine.executeInternal(
          `ALTER TABLE ${CATALOG_SCHEMA}.${table} ADD COLUMN ${column.name} ${column.type}`,
        );
      } catch (e) {
        throw asDateraError(
          e,
          'WORKSPACE_FORMAT_UNSUPPORTED',
          `This workspace could not be upgraded: adding "${column.name}" to ${table} failed`,
          { table, column: column.name },
        );
      }

      // DEFAULT applies to new rows; rows already in the table keep NULL without this.
      if (column.backfill !== undefined) {
        await this.engine.executeInternal(
          `UPDATE ${CATALOG_SCHEMA}.${table} SET ${column.name} = ${column.backfill} WHERE ${column.name} IS NULL`,
        );
      }
    }
  }

  async upsertColumnDefinition(sourceId: string, definition: ColumnDefinition): Promise<void> {
    await this.engine.executeInternal(
      `INSERT OR REPLACE INTO ${CATALOG_SCHEMA}.dictionary_columns (source_id, column_name, definition_json)
       VALUES (?, ?, ?)`,
      [sourceId, definition.column, JSON.stringify(definition)],
    );
  }

  async listColumnDefinitions(sourceId: string): Promise<readonly ColumnDefinition[]> {
    const result = await this.engine.executeInternal(
      `SELECT definition_json FROM ${CATALOG_SCHEMA}.dictionary_columns WHERE source_id = ?`,
      [sourceId],
    );
    return result.rows.map((row) => JSON.parse(String(row[0])) as ColumnDefinition);
  }

  async upsertEntityDefinition(sourceId: string, definition: EntityDefinition): Promise<void> {
    await this.engine.executeInternal(
      `INSERT OR REPLACE INTO ${CATALOG_SCHEMA}.dictionary_entities (source_id, definition_json)
       VALUES (?, ?)`,
      [sourceId, JSON.stringify(definition)],
    );
  }

  async getEntityDefinition(sourceId: string): Promise<EntityDefinition | null> {
    const result = await this.engine.executeInternal(
      `SELECT definition_json FROM ${CATALOG_SCHEMA}.dictionary_entities WHERE source_id = ?`,
      [sourceId],
    );
    const row = result.rows[0];
    return row === undefined ? null : (JSON.parse(String(row[0])) as EntityDefinition);
  }

  /**
   * Workspace-level settings — currently the chosen chat and embedding models.
   *
   * A key/value table rather than columns, because settings accrete and a migration per
   * preference is not worth it. Credentials never live here; they go to the SecretStore.
   */
  async setSetting(key: string, value: string): Promise<void> {
    await this.engine.executeInternal(
      `INSERT OR REPLACE INTO ${CATALOG_SCHEMA}.settings (key, value) VALUES (?, ?)`,
      [key, value],
    );
  }

  async getSetting(key: string): Promise<string | null> {
    const result = await this.engine.executeInternal(
      `SELECT value FROM ${CATALOG_SCHEMA}.settings WHERE key = ?`,
      [key],
    );
    const row = result.rows[0];
    return row === undefined ? null : String(row[0]);
  }

  async insertOperation(operation: AuthoredOperation): Promise<void> {
    await this.engine.executeInternal(
      `INSERT INTO ${CATALOG_SCHEMA}.operations
        (id, dataset_id, name, description, sql, parameters_json, kind, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        operation.id, operation.datasetId, operation.name, operation.description,
        operation.sql, JSON.stringify(operation.parameters), operation.kind, operation.createdAt,
      ],
    );
  }

  async listOperations(datasetId?: string): Promise<readonly AuthoredOperation[]> {
    const where = datasetId === undefined ? '' : ' WHERE dataset_id = ?';
    const result = await this.engine.executeInternal(
      `SELECT id, dataset_id, name, description, sql, parameters_json, kind, created_at
       FROM ${CATALOG_SCHEMA}.operations${where} ORDER BY name`,
      datasetId === undefined ? [] : [datasetId],
    );

    return result.rows.map((row) => ({
      id: String(row[0]),
      datasetId: String(row[1]),
      name: String(row[2]),
      description: String(row[3]),
      sql: String(row[4]),
      parameters: JSON.parse(String(row[5])) as AuthoredOperation['parameters'],
      kind: String(row[6]) as AuthoredOperation['kind'],
      createdAt: String(row[7]),
    }));
  }

  async deleteOperation(id: string): Promise<void> {
    await this.engine.executeInternal(
      `DELETE FROM ${CATALOG_SCHEMA}.operations WHERE id = ?`, [id],
    );
  }

  async insertRelationship(rel: AuthoredRelationship): Promise<void> {
    await this.engine.executeInternal(
      `INSERT INTO ${CATALOG_SCHEMA}.relationships
        (id, dataset_id, from_table, from_column, to_table, to_column, state, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [rel.id, rel.datasetId, rel.fromTable, rel.fromColumn, rel.toTable, rel.toColumn, rel.state, rel.createdAt],
    );
  }

  async listRelationships(datasetId?: string): Promise<readonly AuthoredRelationship[]> {
    const result =
      datasetId === undefined
        ? await this.engine.executeInternal(
            `SELECT id, dataset_id, from_table, from_column, to_table, to_column, state, created_at
             FROM ${CATALOG_SCHEMA}.relationships ORDER BY created_at`,
          )
        : await this.engine.executeInternal(
            `SELECT id, dataset_id, from_table, from_column, to_table, to_column, state, created_at
             FROM ${CATALOG_SCHEMA}.relationships WHERE dataset_id = ? ORDER BY created_at`,
            [datasetId],
          );

    return result.rows.map((row) => ({
      id: String(row[0]),
      datasetId: String(row[1]),
      fromTable: String(row[2]),
      fromColumn: String(row[3]),
      toTable: String(row[4]),
      toColumn: String(row[5]),
      state: String(row[6]) as AuthoredRelationship['state'],
      createdAt: String(row[7]),
    }));
  }

  async insertDataset(dataset: Dataset): Promise<void> {
    await this.engine.executeInternal(
      `INSERT INTO ${CATALOG_SCHEMA}.datasets
         (id, name, description, schema_name, is_default, created_at, kind, derived_from)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        dataset.id,
        dataset.name,
        dataset.description,
        dataset.schemaName,
        dataset.isDefault,
        dataset.createdAt,
        dataset.kind,
        dataset.derivedFrom ?? null,
      ],
    );
  }

  async listDatasets(): Promise<readonly Dataset[]> {
    const result = await this.engine.executeInternal(
      `SELECT id, name, description, schema_name, is_default, created_at, kind, derived_from
       FROM ${CATALOG_SCHEMA}.datasets ORDER BY is_default DESC, name`,
    );
    return result.rows.map((row) => ({
      id: String(row[0]),
      name: String(row[1]),
      description: String(row[2]),
      schemaName: String(row[3]),
      isDefault: row[4] === true,
      createdAt: String(row[5]),
      kind: (row[6] === null ? 'connected' : String(row[6])) as Dataset['kind'],
      derivedFrom: row[7] === null ? undefined : String(row[7]),
    }));
  }

  async insertSource(source: Source): Promise<void> {
    await this.engine.executeInternal(
      `INSERT INTO ${CATALOG_SCHEMA}.sources
        (id, dataset_id, name, kind, origin, table_name, attachment_alias, secret_key, detection_json, added_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        source.id,
        source.datasetId,
        source.name,
        source.kind,
        source.origin,
        source.table ?? null,
        source.attachmentAlias ?? null,
        source.secretKey ?? null,
        JSON.stringify(source.detection),
        source.addedAt,
      ],
    );
  }

  async listSources(): Promise<readonly Source[]> {
    const result = await this.engine.executeInternal(
      `SELECT id, dataset_id, name, kind, origin, table_name, attachment_alias, secret_key, detection_json, added_at
       FROM ${CATALOG_SCHEMA}.sources ORDER BY added_at, name`,
    );
    return result.rows.map((row) => {
      const detection = JSON.parse(String(row[8])) as SourceDetection;
      return {
        id: String(row[0]),
        datasetId: String(row[1]),
        name: String(row[2]),
        kind: String(row[3]) as SourceKind,
        origin: String(row[4]),
        table: row[5] === null ? undefined : String(row[5]),
        attachmentAlias: row[6] === null ? undefined : String(row[6]),
        secretKey: row[7] === null ? undefined : String(row[7]),
        detection,
        addedAt: String(row[9]),
      };
    });
  }

  async updateSourceDataset(id: string, datasetId: string, name: string): Promise<void> {
    await this.engine.executeInternal(
      `UPDATE ${CATALOG_SCHEMA}.sources SET dataset_id = ?, name = ? WHERE id = ?`,
      [datasetId, name, id],
    );
  }

  async renameDataset(id: string, name: string): Promise<void> {
    await this.engine.executeInternal(
      `UPDATE ${CATALOG_SCHEMA}.datasets SET name = ? WHERE id = ?`,
      [name, id],
    );
  }

  async deleteDataset(id: string): Promise<void> {
    await this.engine.executeInternal(`DELETE FROM ${CATALOG_SCHEMA}.datasets WHERE id = ?`, [id]);
  }

  async deleteSource(id: string): Promise<void> {
    await this.engine.executeInternal(`DELETE FROM ${CATALOG_SCHEMA}.sources WHERE id = ?`, [id]);
  }

  async nameExists(datasetId: string, name: string): Promise<boolean> {
    const result = await this.engine.executeInternal(
      `SELECT count(*) FROM ${CATALOG_SCHEMA}.sources WHERE dataset_id = ? AND lower(name) = lower(?)`,
      [datasetId, name],
    );
    return Number(result.rows[0]?.[0] ?? 0) > 0;
  }
}
