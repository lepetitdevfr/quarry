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
}

const ROW_HEIGHT = 22;

export function SchemaTree({
  schema,
  loading,
  error,
  connected,
  onRefresh,
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
                onClick={() => row.expandable && toggle(row.id)}
                title={row.referencesLabel ?? row.detail}
              >
                {row.expandable && (
                  <span className="twisty">{open ? "▾" : "▸"}</span>
                )}
                <span className="schema-label">{row.label}</span>
                {row.kind === "column" && (
                  <>
                    <span
                      className={`schema-type${row.nullable ? " nullable" : ""}`}
                    >
                      {row.detail}
                    </span>
                    {row.isPrimaryKey && <span className="marker pk">PK</span>}
                    {row.referencesLabel && <span className="marker fk">↗</span>}
                  </>
                )}
                {(row.kind === "index" || row.kind === "constraint") && (
                  <span className="schema-def">{row.detail}</span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
