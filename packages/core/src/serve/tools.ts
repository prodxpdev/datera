import type { Dataset } from '../datasets/types.js';

/**
 * Auto-generated MCP tools (spec §8).
 *
 * Generated from the datasets that exist rather than hand-written, so a new dataset is
 * immediately callable and a removed one immediately is not. Definitions only — the core
 * describes the tools, the hosts carry them over stdio or HTTP.
 */

export interface ToolSchema {
  readonly type: 'object';
  readonly properties: Readonly<Record<string, { type: string; description: string }>>;
  readonly required: readonly string[];
}

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: ToolSchema;
  /** The dataset this tool is scoped to, if any. */
  readonly datasetId?: string | undefined;
}

export interface ToolContext {
  readonly dataset: Dataset;
  /** True when this dataset has embedded text — a search tool is only offered then. */
  readonly hasEmbeddings: boolean;
  /** True when writes are granted — a propose tool is only offered then (§6). */
  readonly canWrite: boolean;
}

/** Tool names must be identifier-ish for most MCP clients. */
export function toolSuffix(dataset: Dataset): string {
  return dataset.id.replace(/[^\w]/g, '_').toLowerCase();
}

export function toolsFor(contexts: readonly ToolContext[]): readonly ToolDefinition[] {
  const tools: ToolDefinition[] = [
    {
      name: 'describe_schema',
      description:
        'Describe the tables and columns of a dataset, including any confirmed column meanings. ' +
        'Start here: it tells you what can be queried and what the columns actually mean.',
      inputSchema: {
        type: 'object',
        properties: {
          dataset: { type: 'string', description: 'Dataset id. Omit for the default dataset.' },
        },
        required: [],
      },
    },
  ];

  for (const context of contexts) {
    const suffix = toolSuffix(context.dataset);

    tools.push({
      name: `query_${suffix}`,
      description:
        `Run a read-only DuckDB SELECT against the "${context.dataset.name}" dataset. ` +
        `Writes are refused, and the query cannot reach another dataset. ` +
        `Call describe_schema first if you do not know the columns.`,
      inputSchema: {
        type: 'object',
        properties: {
          sql: { type: 'string', description: 'A single read-only SELECT statement.' },
        },
        required: ['sql'],
      },
      datasetId: context.dataset.id,
    });

    // Advertised only when there is something to search. A tool that is offered and then
    // fails is worse than one that is absent: the agent has already committed to a plan.
    if (context.hasEmbeddings) {
      tools.push({
        name: `search_${suffix}`,
        description:
          `Search the embedded text in "${context.dataset.name}" by meaning, not by keyword. ` +
          `Use this for questions about what text says; use query_ for counts and aggregates.`,
        inputSchema: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'What to look for, in plain language.' },
            k: { type: 'number', description: 'How many matches to return. Default 5.' },
          },
          required: ['text'],
        },
        datasetId: context.dataset.id,
      });
    }

    // §6: agent-proposed mutations surface for human approval and never auto-execute. The
    // name says `propose` and the description says so twice, because the agent reading it
    // is the one that most needs to understand this is not an apply.
    if (context.canWrite) {
      tools.push({
        name: `propose_write_${suffix}`,
        description:
          `Propose a change to "${context.dataset.name}". This DOES NOT EXECUTE anything. ` +
          `It returns a preview — the exact statement, the number of rows affected, and the ` +
          `old and new values — which a human must confirm in Datera before it is applied.`,
        inputSchema: {
          type: 'object',
          properties: {
            instruction: {
              type: 'string',
              description: 'What should change, in plain language or as SQL.',
            },
          },
          required: ['instruction'],
        },
        datasetId: context.dataset.id,
      });
    }
  }

  return tools;
}
