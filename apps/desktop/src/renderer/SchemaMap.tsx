import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { GraphTable, SchemaGraph } from '@datera/core';

/**
 * The dataset, drawn.
 *
 * Two jobs. The first is orientation: a list of table names does not tell someone new to
 * databases that these are separate things joined by a key — a line between two columns
 * does, immediately.
 *
 * The second is feedback while typing. `active` carries the tables the query in the
 * editor currently names, so writing a JOIN lights up the second box and the line between
 * them. That turns "the dataset is the boundary" from a sentence in the docs into
 * something you watch happen.
 *
 * Relationship lines are measured from the laid-out DOM rather than positioned by hand,
 * so they survive wrapping, resizing and a collapsed card.
 */
interface Line {
  readonly key: string;
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly lit: boolean;
}

export function SchemaMap({
  graph,
  active,
  onPick,
}: {
  readonly graph: SchemaGraph;
  /** Tables the query currently references — lit, with everything else dimmed. */
  readonly active: readonly string[];
  /** Clicking a column offers it to the editor. */
  readonly onPick?: ((table: string, column: string) => void) | undefined;
}): JSX.Element {
  const container = useRef<HTMLDivElement | null>(null);
  const anchors = useRef(new Map<string, HTMLElement>());
  const [lines, setLines] = useState<readonly Line[]>([]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  const lit = new Set(active.map((t) => t.toLowerCase()));
  const dimming = lit.size > 0;

  const measure = useCallback(() => {
    const box = container.current?.getBoundingClientRect();
    if (box === undefined) return;

    const next: Line[] = [];
    for (const [i, r] of graph.relationships.entries()) {
      const from = anchors.current.get(`${r.fromTable}.${r.fromColumn}`.toLowerCase());
      const to = anchors.current.get(`${r.toTable}.${r.toColumn}`.toLowerCase());
      if (from === undefined || to === undefined) continue;

      const a = from.getBoundingClientRect();
      const b = to.getBoundingClientRect();
      next.push({
        key: `${i}`,
        x1: a.left + a.width / 2 - box.left,
        y1: a.top + a.height / 2 - box.top,
        x2: b.left + b.width / 2 - box.left,
        y2: b.top + b.height / 2 - box.top,
        lit: lit.has(r.fromTable.toLowerCase()) && lit.has(r.toTable.toLowerCase()),
      });
    }
    setLines(next);
  }, [graph.relationships, active.join(',')]);

  useLayoutEffect(measure, [measure, expanded, graph]);

  useEffect(() => {
    const onResize = (): void => measure();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [measure]);

  if (graph.tables.length === 0) {
    return <div className="emptyrail">Nothing in this dataset yet. Connect a source in Data.</div>;
  }

  const toggle = (name: string): void => {
    const next = new Set(expanded);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setExpanded(next);
  };

  return (
    <div className="schemamap" ref={container} data-schemamap>
      <svg className="maplines" aria-hidden="true">
        {lines.map((l) => (
          <line
            key={l.key}
            className={l.lit ? 'lit' : undefined}
            x1={l.x1}
            y1={l.y1}
            x2={l.x2}
            y2={l.y2}
          />
        ))}
      </svg>

      {graph.tables.map((table) => (
        <TableCard
          key={table.name}
          table={table}
          open={expanded.has(table.name)}
          state={!dimming ? 'neutral' : lit.has(table.name.toLowerCase()) ? 'lit' : 'dim'}
          onToggle={() => toggle(table.name)}
          onPick={onPick}
          register={(column, element) => {
            const key = `${table.name}.${column}`.toLowerCase();
            if (element === null) anchors.current.delete(key);
            else anchors.current.set(key, element);
          }}
        />
      ))}

      {graph.relationships.length === 0 && graph.tables.length > 1 && (
        <div className="maphint">
          No confirmed relationships, so these tables cannot be joined yet. Detect and confirm one
          in <b>Meaning → Relationships</b> — Datera will not join on a guess.
        </div>
      )}
    </div>
  );
}

function TableCard({
  table, open, state, onToggle, onPick, register,
}: {
  readonly table: GraphTable;
  readonly open: boolean;
  readonly state: 'neutral' | 'lit' | 'dim';
  readonly onToggle: () => void;
  readonly onPick?: ((table: string, column: string) => void) | undefined;
  readonly register: (column: string, element: HTMLElement | null) => void;
}): JSX.Element {
  // Collapsed cards still show their keys, because a key is what explains the line
  // leaving the card.
  const shown = open ? table.columns : table.columns.filter((c) => c.isKey).slice(0, 3);
  const rest = table.columns.length - shown.length;

  return (
    <div className={`mapcard ${state}`} data-maptable={table.name}>
      <button className="maphead" onClick={onToggle}>
        <span className="mtn">{table.name}</span>
        <span className="mtr">{table.rowCount.toLocaleString()} rows</span>
        <span className="mtx">{open ? '−' : '+'}</span>
      </button>

      <div className="mapcols">
        {shown.map((column) => (
          <div
            key={column.name}
            className={`mapcol ${column.isKey ? 'key' : ''}`}
            ref={(el) => register(column.name, el)}
            title={column.meaning.length > 0 ? column.meaning : `${column.type}`}
            onClick={() => onPick?.(table.name, column.name)}
          >
            <span className="mcn">{column.name}</span>
            <span className="mct">{column.type}</span>
            {column.isKey && <span className="mck">key</span>}
          </div>
        ))}

        {rest > 0 && (
          <button className="linkbtn mapmore" onClick={onToggle}>
            {open ? 'fewer' : `+${rest} more`}
          </button>
        )}

        {/* Stated, not silently omitted: a column withheld from the model is withheld
            here too, and the count is the honest way to say so. */}
        {table.hiddenColumns > 0 && (
          <div className="maphidden">{table.hiddenColumns} column(s) hidden by you</div>
        )}
      </div>
    </div>
  );
}
