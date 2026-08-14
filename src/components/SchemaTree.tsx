import { useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { flattenSchema } from "../lib/schema";
import type { SchemaRow } from "../lib/schema";
import type { Schema } from "../types";

interface Props {
  schema: Schema | null;
  loading: boolean;
  error: string | null;
  connected: boolean;
  onRefresh: () => void;
}

const ROW_HEIGHT = 22;

/**
 * A short marker for an index or constraint row.
 *
 * The full definition is far too long for a sidebar, so the row shows
 * its name plus a couple of characters saying what kind of thing it is,
 * and puts the definition in the tooltip.
 */
function indexBadge(row: SchemaRow): string {
  if (row.kind === "constraint") {
    const kinds: Record<string, string> = {
      p: "PK",
      f: "FK",
      u: "UNIQUE",
      c: "CHECK",
      x: "EXCL",
    };
    return kinds[row.constraintKind ?? ""] ?? "";
  }

  if (row.isPrimaryIndex) return "PK";
  return row.isUniqueIndex ? "UNIQUE" : "";
}

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
                {/* Always rendered, even when empty: leaf rows without a
                    twisty would otherwise sit 12px left of their own
                    parent, inverting the indentation. */}
                <span className="twisty">
                  {row.expandable ? (open ? "▾" : "▸") : ""}
                </span>
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
                {/* The definition is deliberately NOT rendered inline: at
                    sidebar width it truncates the name it belongs to down
                    to "us…" while showing an equally useless fragment of
                    itself. It lives in the row's tooltip instead. */}
                {(row.kind === "index" || row.kind === "constraint") && (
                  <span className="schema-badge">{indexBadge(row)}</span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
