import { DateraError } from '../errors.js';
import type { HttpPort } from '../ports/http.js';
import type { Dataset } from '../datasets/types.js';
import type { SourceWithStatus } from '../sources/types.js';
import type { ToolDefinition } from '../serve/tools.js';

/**
 * A client for a deployed Datera Server (spec §12.10).
 *
 * The point of this class is that it offers **the same operations as the local façade**,
 * so the UI does not care which it is driving. That is the whole of §12.10's second limb:
 * "when connected to a Datera Server, the same UI drives it".
 *
 * It speaks only the server's *public* API. There is nothing here about issuing tokens,
 * evaluating scopes, or deploying — a client that knew how to do those would be server
 * code living in the public repo.
 */
export interface RemoteQueryResult {
  readonly columns: readonly { name: string; type: string }[];
  readonly rows: readonly (readonly unknown[])[];
  readonly durationMs: number;
}

export class RemoteDatera {
  constructor(
    private readonly http: HttpPort,
    private readonly baseUrl: string,
    private readonly token: string | null,
    private readonly environmentName: string,
  ) {}

  async listDatasets(): Promise<readonly Dataset[]> {
    return (await this.get<{ datasets: Dataset[] }>('/api/datasets')).datasets;
  }

  async listSources(): Promise<readonly SourceWithStatus[]> {
    return (await this.get<{ sources: SourceWithStatus[] }>('/api/sources')).sources;
  }

  async listTools(): Promise<readonly ToolDefinition[]> {
    return (await this.get<{ tools: ToolDefinition[] }>('/api/tools')).tools;
  }

  /**
   * Run a read-only query remotely.
   *
   * The guard runs on the *server*, not here. A client-side check would be advice; the
   * server enforcing it is the guarantee, and this method surfaces the server's refusal
   * with its original code so the UI reacts identically either way.
   */
  async query(datasetId: string, sql: string): Promise<RemoteQueryResult> {
    const response = await this.post('/api/query', { dataset: datasetId, sql });

    if (response.status === 400) {
      const body = safeJson<{ content?: { text: string }[] }>(response.body);
      const message = body?.content?.[0]?.text ?? response.body;
      throw new DateraError(classifyRemoteError(message), message, {
        environment: this.environmentName,
        remote: true,
      });
    }

    this.assertOk(response.status, response.body);

    const parsed = safeJson<{ content?: { text: string }[] }>(response.body);
    const payload = safeJson<RemoteQueryResult>(parsed?.content?.[0]?.text ?? '');
    if (payload === null) {
      throw new DateraError('CONNECTION_FAILED', 'The server returned an unreadable result.', {
        environment: this.environmentName,
      });
    }
    return { columns: payload.columns ?? [], rows: payload.rows ?? [], durationMs: 0 };
  }

  /** Cheap reachability check. Never throws — the caller wants a boolean, not an incident. */
  async reachable(): Promise<{ ok: boolean; reason?: string }> {
    try {
      const response = await this.http.send({
        method: 'GET',
        url: `${this.baseUrl}/healthz`,
        timeoutMs: 2_000,
      });
      return response.status >= 200 && response.status < 300
        ? { ok: true }
        : { ok: false, reason: `HTTP ${response.status}` };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
  }

  async push(manifest: string, tables: readonly { name: string; csv: string }[]): Promise<void> {
    const response = await this.post('/api/push', { manifest, tables });
    this.assertOk(response.status, response.body);
  }

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      ...(this.token === null ? {} : { authorization: `Bearer ${this.token}` }),
    };
  }

  private async get<T>(path: string): Promise<T> {
    let response;
    try {
      response = await this.http.send({
        method: 'GET',
        url: `${this.baseUrl}${path}`,
        headers: this.headers(),
        timeoutMs: 15_000,
      });
    } catch (e) {
      throw this.unreachable(e);
    }

    this.assertOk(response.status, response.body);
    const parsed = safeJson<T>(response.body);
    if (parsed === null) {
      throw new DateraError('CONNECTION_FAILED', 'The server returned an unreadable response.', {
        environment: this.environmentName,
      });
    }
    return parsed;
  }

  private async post(path: string, body: unknown): Promise<{ status: number; body: string }> {
    try {
      const response = await this.http.send({
        method: 'POST',
        url: `${this.baseUrl}${path}`,
        headers: this.headers(),
        body: JSON.stringify(body),
        timeoutMs: 120_000,
      });
      return { status: response.status, body: response.body };
    } catch (e) {
      throw this.unreachable(e);
    }
  }

  private assertOk(status: number, body: string): void {
    if (status >= 200 && status < 300) return;

    if (status === 401 || status === 403) {
      throw new DateraError(
        'CONNECTION_FAILED',
        `"${this.environmentName}" rejected the token. Check the token for this environment.`,
        { environment: this.environmentName, status },
      );
    }
    throw new DateraError(
      'CONNECTION_FAILED',
      `"${this.environmentName}" returned HTTP ${status}: ${body.slice(0, 200)}`,
      { environment: this.environmentName, status },
    );
  }

  private unreachable(e: unknown): DateraError {
    return new DateraError(
      'CONNECTION_FAILED',
      `Could not reach "${this.environmentName}": ${e instanceof Error ? e.message : String(e)}`,
      { environment: this.environmentName },
    );
  }
}

/**
 * Preserve the server's meaning across the wire.
 *
 * A refused write must arrive at the UI as READ_ONLY_VIOLATION whether it was refused
 * locally or remotely, or "the same UI drives it" would only be true for the happy path.
 */
function classifyRemoteError(message: string): 'READ_ONLY_VIOLATION' | 'CROSS_DATASET_ACCESS' | 'SQL_ERROR' {
  if (/read-only/i.test(message)) return 'READ_ONLY_VIOLATION';
  if (/outside|dataset/i.test(message)) return 'CROSS_DATASET_ACCESS';
  return 'SQL_ERROR';
}

function safeJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}
