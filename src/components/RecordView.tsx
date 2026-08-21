import { useMemo, useState } from "react";
import { ContextMenu, useContextMenu } from "./ContextMenu";
import { groupRecent, summarise } from "../lib/recent";
import type { Scope } from "../lib/recent";
import { describeWrite, matchesWrite, writeIsHere } from "../lib/writes";
import type { Connection, RecentItem, WriteRecord } from "../types";

interface Props {
  record: string;
  items: RecentItem[];
  writes: WriteRecord[];
  connections: Connection[];
  activeConnectionId: string | null;
  /** Open a new tab holding this SQL. Never runs it. */
  onOpen: (sql: string) => void;
  onForget: (id: string) => void;
}

/** When it happened, in the reader's own timezone. */
function when(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return at.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * History and Writes, at a size worth reading.
 *
 * They lived in the sidebar first and did not fit: a statement is a line
 * of SQL and the sidebar is 250px, so the two lists that exist to be
 * read were the ones being truncated. Here the SQL keeps its own column
 * and its newlines, and everything else is a narrow column beside it.
 */
export function RecordView({
  record,
  items,
  writes,
  connections,
  activeConnectionId,
  onOpen,
  onForget,
}: Props) {
  const [filter, setFilter] = useState("");
  // Scoped to the connection you are on, by default. Both lists are
  // almost always read to answer a question about the database in front
  // of you; the other databases' work is still one click away rather
  // than gone, because reconnecting to find an old query is a real
  // thing people do.
  const [scope, setScope] = useState<Scope>("here");
  const { menu, open: openMenu, close: closeMenu } = useContextMenu();

  const history = useMemo(
    () => groupRecent(items, activeConnectionId, filter, scope),
    [items, activeConnectionId, filter, scope],
  );
  const written = useMemo(
    () =>
      writes
        .filter(
          (w) =>
            scope === "all" ||
            activeConnectionId === null ||
            writeIsHere(w, activeConnectionId),
        )
        .filter((w) => matchesWrite(w, filter)),
    [writes, filter, scope, activeConnectionId],
  );

  const isWrites = record === "writes";
  const empty = isWrites ? written.length === 0 : history.length === 0;
  const nothingAtAll = isWrites ? writes.length === 0 : items.length === 0;

  const tagOf = (connectionId: string | null, fallback?: string) => {
    const origin = connections.find((c) => c.id === connectionId);
    const label = origin?.tag ?? fallback;
    if (!label) return null;
    return (
      <span
        className="picker-tag overline"
        style={
          origin ? { color: origin.colour, borderColor: origin.colour } : undefined
        }
      >
        {label}
      </span>
    );
  };

  return (
    <div className="record-view">
      <header className="record-head">
        <h2 className="overline">{isWrites ? "Writes" : "History"}</h2>
        <input
          className="schema-filter"
          placeholder={isWrites ? "Filter writes…" : "Filter history…"}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          spellCheck={false}
        />
        {/* Only worth offering while there is a connection to scope to.
            Disconnected, "this connection" would mean nothing and the
            list already shows everything. */}
        {activeConnectionId !== null && (
          <div className="record-scope">
            <button
              className={scope === "here" ? "overline active" : "overline"}
              onClick={() => setScope("here")}
            >
              This connection
            </button>
            <button
              className={scope === "all" ? "overline active" : "overline"}
              onClick={() => setScope("all")}
            >
              All
            </button>
          </div>
        )}
      </header>

      {empty && (
        <p className="record-empty">
          {nothingAtAll
            ? isWrites
              ? "Nothing yet. Every write this app makes is recorded here."
              : "Nothing yet. Statements you run and tabs you close land here."
            : scope === "here" && filter === ""
              ? // Distinguishing the two reasons for an empty list
                // matters: one means you have nothing, the other means
                // you are looking at the wrong slice of it.
                "Nothing against this connection yet — All shows every database."
              : "Nothing matches."}
        </p>
      )}

      {!empty && (
        <table className="record-table">
          <thead>
            <tr>
              <th className="record-when">When</th>
              <th className="record-where">Where</th>
              <th>Statement</th>
              <th className="record-what">
                {isWrites ? "Outcome" : "Result"}
              </th>
            </tr>
          </thead>
          <tbody>
            {isWrites
              ? written.map((write) => (
                  <tr
                    key={write.id}
                    className={`record-row ${write.outcome}`}
                    onDoubleClick={() => onOpen(write.sql)}
                    onContextMenu={(e) =>
                      openMenu(e, [
                        {
                          label: "Open in a new tab",
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
                          onSelect: () =>
                            write.undo_sql && onOpen(write.undo_sql),
                        },
                      ])
                    }
                  >
                    <td className="record-when">{when(write.at)}</td>
                    <td className="record-where">
                      {tagOf(write.connection_id, write.tag)}
                      <span className="record-connection">
                        {write.connection_name}
                      </span>
                    </td>
                    <td>
                      <pre className="record-sql">{write.sql}</pre>
                    </td>
                    <td className="record-what">{describeWrite(write)}</td>
                  </tr>
                ))
              : history.map(({ item, here }) => (
                  <tr
                    key={item.id}
                    className={`record-row${here ? " here" : ""}`}
                    onDoubleClick={() => onOpen(item.sql)}
                    onContextMenu={(e) =>
                      openMenu(e, [
                        {
                          label: "Open in a new tab",
                          onSelect: () => onOpen(item.sql),
                        },
                        {
                          label: "Copy SQL",
                          onSelect: () =>
                            void navigator.clipboard.writeText(item.sql),
                        },
                        { separator: true as const },
                        {
                          label: "Forget this",
                          danger: true,
                          onSelect: () => onForget(item.id),
                        },
                      ])
                    }
                  >
                    <td className="record-when">{when(item.last_at)}</td>
                    <td className="record-where">
                      {tagOf(item.connection_id)}
                    </td>
                    <td>
                      <pre className="record-sql">{item.sql}</pre>
                    </td>
                    <td className="record-what">{summarise(item)}</td>
                  </tr>
                ))}
          </tbody>
        </table>
      )}

      <ContextMenu menu={menu} onClose={closeMenu} />
    </div>
  );
}
