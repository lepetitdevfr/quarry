import { useMemo, useState } from "react";
import { ContextMenu, useContextMenu } from "./ContextMenu";
import { describeWrite, matchesWrite } from "../lib/writes";
import type { Connection, WriteRecord } from "../types";

interface Props {
  writes: WriteRecord[];
  connections: Connection[];
  /** Open a new tab holding this SQL. Never runs it. */
  onOpen: (sql: string) => void;
}

/** The first line with anything on it, which is what a row can show. */
function firstLine(sql: string): string {
  return sql.split("\n").find((l) => l.trim() !== "")?.trim() ?? sql.trim();
}

/**
 * What this app wrote, newest first.
 *
 * Read-only by construction: there is no delete here and no way to alter
 * a row. A log somebody can edit answers a weaker question than the one
 * it exists for.
 */
export function WritesList({ writes, connections, onOpen }: Props) {
  const [filter, setFilter] = useState("");
  const { menu, open: openMenu, close: closeMenu } = useContextMenu();

  const rows = useMemo(
    () => writes.filter((w) => matchesWrite(w, filter)),
    [writes, filter],
  );

  return (
    <>
      <div className="schema-toolbar">
        <input
          className="schema-filter"
          placeholder="Filter writes…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          spellCheck={false}
        />
      </div>

      {rows.length === 0 && (
        <p className="tree-empty">
          {writes.length === 0
            ? "Nothing yet. Every write this app makes is recorded here."
            : "Nothing matches."}
        </p>
      )}

      <div className="recent-rows">
        {rows.map((write) => {
          const colour = connections.find(
            (c) => c.id === write.connection_id,
          )?.colour;

          return (
            <div
              key={write.id}
              className={`recent-row write-row ${write.outcome}`}
              role="button"
              tabIndex={0}
              title={write.sql}
              onDoubleClick={() => onOpen(write.sql)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  onOpen(write.sql);
                }
              }}
              onContextMenu={(e) =>
                openMenu(e, [
                  {
                    label: "Open in a new tab",
                    shortcut: "↵",
                    onSelect: () => onOpen(write.sql),
                  },
                  {
                    label: "Copy SQL",
                    onSelect: () =>
                      void navigator.clipboard.writeText(write.sql),
                  },
                  {
                    label: "Open the undo",
                    disabled: write.undo_sql === null,
                    title:
                      write.undo_sql === null
                        ? "only the grid's own edits carry an undo"
                        : undefined,
                    onSelect: () => write.undo_sql && onOpen(write.undo_sql),
                  },
                ])
              }
            >
              <span className="recent-sql">{firstLine(write.sql)}</span>
              <span className="recent-meta">
                {/* The tag it ran against, from the row rather than from
                    the connection list: the connection may be gone, and
                    the row still has to say where this happened. */}
                <span
                  className="picker-tag overline"
                  style={
                    colour ? { color: colour, borderColor: colour } : undefined
                  }
                >
                  {write.tag}
                </span>
                <span className="recent-summary">{describeWrite(write)}</span>
              </span>
            </div>
          );
        })}
      </div>

      <ContextMenu menu={menu} onClose={closeMenu} />
    </>
  );
}
