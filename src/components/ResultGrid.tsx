import { useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { formatCell } from "../lib/format";
import { isTruncated, nextSort, sortedIndices } from "../lib/gridSort";
import type { SortState } from "../lib/gridSort";
import type { QueryResult } from "../types";

interface Props {
  result: QueryResult;
  /** The statement that produced `result`, for truncation detection. */
  sql: string;
  sort: SortState | null;
  onSortChange: (sort: SortState | null) => void;
  /**
   * True when the rows arrived already ordered by the database — a
   * table Data tab, which re-runs with `ORDER BY`. Sorting them again
   * here would be wasted work at best and, on a truncated result,
   * wrong.
   */
  serverSorted: boolean;
}

const ROW_HEIGHT = 28;

export function ResultGrid({
  result,
  sql,
  sort,
  onSortChange,
  serverSorted,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Only the visible rows are mounted. Without this a 100k-row result
  // creates 100k DOM nodes and the window stops responding.
  const virtualizer = useVirtualizer({
    count: result.rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  if (result.columns.length === 0) {
    return <div className="grid-empty">Statement returned no columns.</div>;
  }

  const order = serverSorted
    ? result.rows.map((_, i) => i)
    : sortedIndices(result.rows, sort);

  // Only a locally sorted page can mislead: a Data tab's ordering was
  // done by the database over the whole table.
  const partial = !serverSorted && sort !== null && isTruncated(result.rows.length, sql);

  return (
    <div className="result-grid" ref={scrollRef}>
      <table>
        <thead>
          <tr>
            {/* Ordinal gutter. Empty header: numbering the numbering
                column would be noise. */}
            <th className="row-num" aria-label="Row number" />
            {result.columns.map((c, i) => (
              // Column names can repeat (e.g. `SELECT 1 as n, 2 as n`), so
              // the index is used as the key instead of the name.
              <th
                key={i}
                title={c.type_name}
                className={sort?.column === i ? "sorted" : undefined}
                onClick={() => onSortChange(nextSort(sort, i))}
              >
                {c.name}
                <span className="col-type">{c.type_name}</span>
                {sort?.column === i && (
                  <span className="sort-arrow">
                    {sort.direction === "asc" ? "▲" : "▼"}
                  </span>
                )}
                {sort?.column === i && partial && (
                  <span
                    className="sort-partial"
                    title={`sorted within the first ${result.rows.length} rows fetched, not the whole table`}
                  >
                    !
                  </span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody style={{ height: `${virtualizer.getTotalSize()}px` }}>
          {virtualizer.getVirtualItems().map((item) => {
            const row = result.rows[order[item.index]];
            return (
              <tr
                key={item.key}
                style={{
                  position: "absolute",
                  transform: `translateY(${item.start}px)`,
                  height: `${ROW_HEIGHT}px`,
                }}
              >
                <td className="row-num">{item.index + 1}</td>
                {row.map((cell, i) => {
                  const { text, kind } = formatCell(cell);
                  return (
                    <td key={i} className={`cell-${kind}`} title={text}>
                      {text}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
