import { useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { flattenSchema } from "../lib/schema";
import type { Schema } from "../types";

interface Props {
  schema: Schema | null;
  loading: boolean;
  error: string | null;
  connected: boolean;
  onRefresh: () => void;
  onTableDoubleClick: (schema: string, table: string) => void;
  /** Single-click on a table row. */
  onTableClick: (schema: string, table: string) => void;
}

/** Must match --h-row in App.css: the virtualizer positions rows by this
    number, so a mismatch overlaps or gaps every row. */
const ROW_HEIGHT = 26;

export function SchemaTree({
  schema,
  loading,
  error,
  connected,
  onRefresh,
  onTableDoubleClick,
  onTableClick,
}: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  const rows = useMemo(
    () => flattenSchema(schema, expanded, filter),
    [schema, expanded, filter],
  );

  // A schema with every table expanded runs to thousands of rows, so
  // the tree is windowed exactly like the result grid.
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20,
  });

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (!connected) {
    return <p className="tree-empty">Not connected.</p>;
  }

  return (
    <>
      <div className="schema-toolbar">
        <input
          className="schema-filter"
          placeholder="Filter tables and columns…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          spellCheck={false}
        />
        <button
          className="row-action"
          title="Refresh schema"
          onClick={onRefresh}
          disabled={loading}
        >
          {loading ? "…" : "⟳"}
        </button>
      </div>

      {error && (
        <p className="tree-error">
          {error} <button className="link" onClick={onRefresh}>Retry</button>
        </p>
      )}

      {rows.length === 0 && !loading && !error && (
        <p className="tree-empty">
          {filter === "" ? "No tables." : "Nothing matches."}
        </p>
      )}

      <div className="schema-rows" ref={scrollRef}>
        <div style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative" }}>
          {virtualizer.getVirtualItems().map((item) => {
            const row = rows[item.index];
            const open = expanded.has(row.id);

            return (
              <div
                key={row.id}
                className={`tree-row schema-${row.kind}`}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  right: 0,
                  height: `${ROW_HEIGHT}px`,
                  transform: `translateY(${item.start}px)`,
                  paddingLeft: 8 + row.depth * 12,
                }}
                onClick={() => {
                  // A schema expands; a table opens its detail tab. The
                  // two kinds are the whole tree, so these never overlap.
                  if (row.expandable) toggle(row.id);
                  else if (row.tableSchema && row.tableName) {
                    onTableClick(row.tableSchema, row.tableName);
                  }
                }}
                onDoubleClick={() => {
                  if (row.kind === "table" && row.tableSchema && row.tableName) {
                    onTableDoubleClick(row.tableSchema, row.tableName);
                  }
                }}
              >
                {/* Always rendered, even when empty: table rows without a
                    twisty would otherwise sit 12px left of their own
                    schema, inverting the indentation. */}
                <span className="twisty">
                  {row.expandable ? (open ? "▾" : "▸") : ""}
                </span>
                <span className="schema-label">{row.label}</span>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
