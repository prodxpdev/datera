/**
 * The HTTP surface, described once (spec §8).
 *
 * This is the **single definition** of the API: the CLI routes from it and the UI
 * documents from it. Documentation written separately from an implementation drifts —
 * usually just after the release where somebody changed a path — and a data service whose
 * docs lie about its endpoints is worse than one with none.
 */

export interface ApiParameter {
  readonly name: string;
  readonly type: string;
  readonly required: boolean;
  readonly description: string;
}

export interface ApiEndpoint {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly summary: string;
  readonly description: string;
  /** False for the health checks — a liveness probe that needs a credential is not one. */
  readonly requiresAuth: boolean;
  readonly body: readonly ApiParameter[];
  readonly returns: string;
  /** A copy-pasteable curl, with the token as a placeholder. */
  readonly example: string;
  /** Present when the endpoint is behind an explicit opt-in. */
  readonly requiresFlag?: string | undefined;
}

export const API_ENDPOINTS: readonly ApiEndpoint[] = [
  {
    method: 'GET',
    path: '/healthz',
    summary: 'Liveness',
    description: 'Answers while the process is up. Deliberately unauthenticated.',
    requiresAuth: false,
    body: [],
    returns: '{ "ok": true }',
    example: 'curl $DATERA_URL/healthz',
  },
  {
    method: 'GET',
    path: '/readyz',
    summary: 'Readiness',
    description: 'Answers once the workspace is open and queryable.',
    requiresAuth: false,
    body: [],
    returns: '{ "ok": true }',
    example: 'curl $DATERA_URL/readyz',
  },
  {
    method: 'POST',
    path: '/mcp',
    summary: 'MCP over HTTP',
    description:
      'JSON-RPC 2.0. Supports initialize, tools/list, tools/call and ping. The same handler ' +
      'the stdio transport uses, so both transports behave identically.',
    requiresAuth: true,
    body: [
      { name: 'jsonrpc', type: '"2.0"', required: true, description: 'Protocol version.' },
      { name: 'id', type: 'string | number', required: false, description: 'Omit for a notification.' },
      { name: 'method', type: 'string', required: true, description: 'initialize | tools/list | tools/call | ping' },
      { name: 'params', type: 'object', required: false, description: 'Method arguments.' },
    ],
    returns: 'A JSON-RPC response, or 204-equivalent empty object for a notification.',
    example:
      `curl -X POST $DATERA_URL/mcp \\\n` +
      `  -H 'authorization: Bearer $TOKEN' -H 'content-type: application/json' \\\n` +
      `  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
  },
  {
    method: 'POST',
    path: '/api/operations',
    summary: 'Call an authored operation by name',
    description:
      'Calls a named, typed operation this workspace defines — the shape of the call is the ' +
      "operation's own parameters, not a SQL string. A read returns rows. A write returns a " +
      'PROPOSAL and applies nothing: §6 says a change is never executed without an explicit ' +
      'confirm, and confirming is a human act. Ratify it with /api/writes/confirm.',
    requiresAuth: true,
    body: [
      { name: 'dataset', type: 'string', required: true, description: 'Dataset the operation belongs to' },
      { name: 'name', type: 'string', required: true, description: 'Operation name' },
      { name: 'arguments', type: 'object', required: false, description: 'Values for its declared parameters' },
    ],
    returns: '{ "kind": "read" | "write", "rows"?: unknown[][], "proposal"?: WriteProposal }',
    example: `curl -X POST -H 'authorization: Bearer $TOKEN' -H 'content-type: application/json' \\
  -d '{"dataset":"ungrouped","name":"revenue_for_product","arguments":{"product":"Trail Hoodie"}}' \\
  $DATERA_URL/api/operations`,
  },
  {
    method: 'GET',
    path: '/api/tools',
    summary: 'List the auto-generated tools',
    description:
      'The same tools MCP exposes, as plain JSON. A search tool appears only where something ' +
      'is embedded, and a write tool only where a grant exists.',
    requiresAuth: true,
    body: [],
    returns: '{ "tools": ToolDefinition[] }',
    example: `curl -H 'authorization: Bearer $TOKEN' $DATERA_URL/api/tools`,
  },
  {
    method: 'GET',
    path: '/api/datasets',
    summary: 'List datasets',
    description: 'Every dataset this server exposes, with its kind and schema name.',
    requiresAuth: true,
    body: [],
    returns: '{ "datasets": Dataset[] }',
    example: `curl -H 'authorization: Bearer $TOKEN' $DATERA_URL/api/datasets`,
  },
  {
    method: 'GET',
    path: '/api/sources',
    summary: 'List sources',
    description: 'Sources with their availability. Origins are redacted — never a password.',
    requiresAuth: true,
    body: [],
    returns: '{ "sources": SourceWithStatus[] }',
    example: `curl -H 'authorization: Bearer $TOKEN' $DATERA_URL/api/sources`,
  },
  {
    method: 'POST',
    path: '/api/query',
    summary: 'Run a read-only query',
    description:
      'Executes a single SELECT against one dataset. Writes are refused and the query cannot ' +
      'reach another dataset — the same two guards the desktop UI runs, enforced here rather ' +
      'than trusted to the caller.',
    requiresAuth: true,
    body: [
      { name: 'dataset', type: 'string', required: false, description: 'Dataset id. Defaults to "ungrouped".' },
      { name: 'sql', type: 'string', required: true, description: 'A single read-only SELECT.' },
    ],
    returns: '{ content: [{ type: "text", text: "{columns, rows}" }], isError: boolean }',
    example:
      `curl -X POST $DATERA_URL/api/query \\\n` +
      `  -H 'authorization: Bearer $TOKEN' -H 'content-type: application/json' \\\n` +
      `  -d '{"dataset":"ungrouped","sql":"SELECT count(*) FROM orders"}'`,
  },
  {
    method: 'POST',
    path: '/api/push',
    summary: 'Receive a pushed dataset',
    description:
      'Accepts a dataset exported by a Datera client. Off by default: receiving data writes to ' +
      'the workspace, which is a different grant from serving reads.',
    requiresAuth: true,
    requiresFlag: '--allow-push',
    body: [
      { name: 'manifest', type: 'string', required: true, description: 'The export manifest, as JSON text.' },
      { name: 'tables', type: '{ name, csv }[]', required: true, description: 'Table contents as CSV.' },
    ],
    returns: '{ ok: true, datasetId: string, tables: string[] }',
    example: '(sent by the Datera client’s Push, not usually by hand)',
  },
];

/** Endpoints grouped for display, in the order someone would read them. */
export function apiEndpointsByGroup(): readonly { group: string; endpoints: readonly ApiEndpoint[] }[] {
  return [
    { group: 'Health', endpoints: API_ENDPOINTS.filter((e) => !e.requiresAuth) },
    { group: 'MCP', endpoints: API_ENDPOINTS.filter((e) => e.path === '/mcp') },
    {
      group: 'REST',
      endpoints: API_ENDPOINTS.filter((e) => e.path.startsWith('/api/')),
    },
  ];
}
