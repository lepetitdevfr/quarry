import { useMemo, useState } from "react";
import { ContextMenu, useContextMenu } from "./ContextMenu";
import { groupRecent, summarise } from "../lib/recent";
import type { Connection, RecentItem } from "../types";

interface Props {
  items: RecentItem[];
  connections: Connection[];
  activeConnectionId: string | null;
  /** Open a new tab holding this SQL. Never runs it. */
  onOpen: (sql: string) => void;
  onForget: (id: string) => void;
}

/** The first line with anything on it, which is what a row can show. */
function firstLine(sql: string): string {
  return sql.split("\n").find((l) => l.trim() !== "")?.trim() ?? sql.trim();
}

/**
 * Everything you ran or closed, newest first, this connection's work at
 * the top.
 *
 * Opening a row opens a tab and runs nothing — the same rule the schema
 * tree follows, and the reason recovering work cannot cost work.
 */
export function RecentList({
  items,
  connections,
  activeConnectionId,
  onOpen,
  onForget,
}: Props) {
  const [filter, setFilter] = useState("");
  const { menu, open: openMenu, close: closeMenu } = useContextMenu();

  const rows = useMemo(
    () => groupRecent(items, activeConnectionId, filter),
    [items, activeConnectionId, filter],
  );

  return (
    <>
      <div className="schema-toolbar">
        <input
          className="schema-filter"
          placeholder="Filter history…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          spellCheck={false}
        />
      </div>

      {rows.length === 0 && (
        <p className="tree-empty">
          {items.length === 0
            ? "Nothing yet. Statements you run and tabs you close land here."
            : "Nothing matches."}
        </p>
      )}

      <div className="recent-rows">
        {rows.map(({ item, here }) => {
          const origin = connections.find((c) => c.id === item.connection_id);
          return (
            <div
              key={item.id}
              className={`recent-row${here ? " here" : ""}`}
              role="button"
              tabIndex={0}
              title={item.sql}
              onDoubleClick={() => onOpen(item.sql)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  onOpen(item.sql);
                }
              }}
              onContextMenu={(e) =>
                openMenu(e, [
                  {
                    label: "Open in a new tab",
                    shortcut: "↵",
                    onSelect: () => onOpen(item.sql),
                  },
                  {
                    label: "Copy SQL",
                    onSelect: () => void navigator.clipboard.writeText(item.sql),
                  },
                  { separator: true },
                  {
                    label: "Forget this",
                    danger: true,
                    onSelect: () => onForget(item.id),
                  },
                ])
              }
            >
              <span className="recent-sql">{firstLine(item.sql)}</span>
              <span className="recent-meta">
                {origin && (
                  <span
                    className="picker-tag overline"
                    style={{ color: origin.colour, borderColor: origin.colour }}
                  >
                    {origin.tag}
                  </span>
                )}
                <span className="recent-summary">{summarise(item)}</span>
              </span>
            </div>
          );
        })}
      </div>

      <ContextMenu menu={menu} onClose={closeMenu} />
    </>
  );
}
