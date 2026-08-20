import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ContextMenu, useContextMenu } from "./ContextMenu";
import { flattenSchema } from "../lib/schema";
import type { SchemaRow } from "../lib/schema";
import type { Schema } from "../types";

interface Props {
  schema: Schema | null;
  loading: boolean;
  error: string | null;
  connected: boolean;
  onRefresh: () => void;
  /** Open the table's rows. Runs a query, so it is never automatic. */
  onOpenData: (schema: string, table: string) => void;
  /** Open the table's structure. Renders from the cached schema. */
  onOpenStructure: (schema: string, table: string) => void;
  /** The table the active tab is showing, so the tree can mark it. */
  activeTable: { schema: string; table: string } | null;
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
  onOpenData,
  onOpenStructure,
  activeTable,
}: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  // Which row the keyboard and the pointer agree is current. Selecting
  // is free; opening is not, which is the whole point of separating
  // them — see the click handler below.
  const [cursor, setCursor] = useState<number>(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const { menu, open: openMenu, close: closeMenu } = useContextMenu();

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

  // The row list changes shape as schemas expand and the filter narrows;
  // a cursor past the end selects nothing at all.
  useEffect(() => {
    setCursor((current) => Math.min(current, Math.max(0, rows.length - 1)));
  }, [rows.length]);

  const toggle = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  /**
   * What a row does when it is opened rather than merely selected.
   *
   * A schema expands. A table opens its rows — which runs a query, and
   * is why a single click no longer does this: browsing a tree should
   * cost nothing, and it used to cost one `SELECT` per click, with the
   * first click of every double-click firing one that the structure tab
   * then immediately replaced.
   */
  const activate = useCallback(
    (row: SchemaRow) => {
      if (row.expandable) toggle(row.id);
      else if (row.tableSchema && row.tableName) {
        onOpenData(row.tableSchema, row.tableName);
      }
    },
    [toggle, onOpenData],
  );

  // Set when the cursor moved by keyboard, so the effect below knows to
  // chase focus to the new row. The rows are virtualized: the one being
  // moved to may not be mounted yet at the moment the key is handled,
  // and the one being moved from may unmount, dropping focus to the
  // body and ending keyboard navigation after a single press.
  const chaseFocus = useRef(false);

  useEffect(() => {
    if (!chaseFocus.current) return;
    chaseFocus.current = false;
    scrollRef.current
      ?.querySelector<HTMLDivElement>(`[data-index="${cursor}"]`)
      ?.focus();
  }, [cursor, rows]);

  function moveCursor(delta: number) {
    chaseFocus.current = true;
    setCursor((current) => {
      const next = Math.min(rows.length - 1, Math.max(0, current + delta));
      virtualizer.scrollToIndex(next);
      return next;
    });
  }

  function menuItems(row: SchemaRow) {
    if (row.expandable) {
      return [
        {
          label: expanded.has(row.id) ? "Collapse" : "Expand",
          onSelect: () => toggle(row.id),
        },
        {
          label: "Copy name",
          onSelect: () => void navigator.clipboard.writeText(row.label),
        },
      ];
    }
    const qualified = `${row.tableSchema}.${row.tableName}`;
    return [
      {
        label: "Open data",
        shortcut: "↵",
        onSelect: () => onOpenData(row.tableSchema!, row.tableName!),
      },
      {
        label: "Open structure",
        shortcut: "⇧↵",
        onSelect: () => onOpenStructure(row.tableSchema!, row.tableName!),
      },
      { separator: true as const },
      {
        label: "Copy qualified name",
        onSelect: () => void navigator.clipboard.writeText(qualified),
      },
      {
        label: "Copy SELECT statement",
        onSelect: () =>
          void navigator.clipboard.writeText(
            `select * from ${qualified} limit 100;`,
          ),
      },
    ];
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
          onKeyDown={(e) => {
            // Down from the filter enters the list, which is what the
            // field is for — you type two letters and then move.
            if (e.key === "ArrowDown") {
              e.preventDefault();
              scrollRef.current
                ?.querySelector<HTMLDivElement>(".tree-row")
                ?.focus();
            }
          }}
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
            const isActive =
              row.kind === "table" &&
              activeTable !== null &&
              activeTable.schema === row.tableSchema &&
              activeTable.table === row.tableName;

            return (
              <div
                key={row.id}
                className={`tree-row schema-${row.kind}${
                  isActive ? " active" : ""
                }${item.index === cursor ? " selected" : ""}`}
                role="treeitem"
                data-index={item.index}
                aria-expanded={row.expandable ? open : undefined}
                aria-selected={item.index === cursor}
                // Only the cursor row is tabbable, so Tab enters the
                // tree once rather than walking every table in it.
                tabIndex={item.index === cursor ? 0 : -1}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  right: 0,
                  height: `${ROW_HEIGHT}px`,
                  transform: `translateY(${item.start}px)`,
                  paddingLeft: 8 + row.depth * 12,
                }}
                onClick={(e) => {
                  setCursor(item.index);
                  e.currentTarget.focus();
                  // A schema still toggles on a single click: expanding
                  // is free, and a twisty that needs a double-click is
                  // not a twisty.
                  if (row.expandable) toggle(row.id);
                }}
                onDoubleClick={() => activate(row)}
                onContextMenu={(e) => {
                  setCursor(item.index);
                  openMenu(e, menuItems(row));
                }}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    moveCursor(1);
                  } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    moveCursor(-1);
                  } else if (e.key === "ArrowRight") {
                    e.preventDefault();
                    if (row.expandable && !open) toggle(row.id);
                    else moveCursor(1);
                  } else if (e.key === "ArrowLeft") {
                    e.preventDefault();
                    if (row.expandable && open) toggle(row.id);
                    else moveCursor(-1);
                  } else if (e.key === "Enter") {
                    e.preventDefault();
                    // Shift+Enter opens the structure, matching the
                    // context menu — the two must not disagree.
                    if (e.shiftKey && row.tableSchema && row.tableName) {
                      onOpenStructure(row.tableSchema, row.tableName);
                    } else {
                      activate(row);
                    }
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
                {/* Only views and materialised views carry one. A row
                    with no badge is an ordinary table, which is what the
                    eye already assumes. */}
                {row.relationLabel && (
                  <span className="relation-badge overline">
                    {row.relationLabel}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <ContextMenu menu={menu} onClose={closeMenu} />
    </>
  );
}
