import { useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { formatCell } from "../lib/format";
import { isTruncated, nextSort, sortedIndices } from "../lib/gridSort";
import type { SortState } from "../lib/gridSort";
import {
  MIN_WIDTH,
  columnsKey,
  fitWidth,
  initialWidths,
  resized,
} from "../lib/gridWidths";
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

  const [widths, setWidths] = useState<number[]>(() =>
    initialWidths(result.columns, result.rows),
  );

  // Re-measure when the column *shape* changes, not on every new
  // result. Sorting a Data tab re-runs the query and returns a fresh
  // result object holding the very same columns; keying this on result
  // identity threw away the widths you had dragged every time you
  // sorted.
  const shape = columnsKey(result.columns);
  useEffect(() => {
    setWidths(initialWidths(result.columns, result.rows));
    // `shape` is the trigger; result is read, not watched.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape]);

  // Drag state lives in a ref, not state: it changes on every
  // pointermove and re-rendering a virtualized grid at that rate is
  // what makes a resize feel laggy.
  const drag = useRef<{ index: number; startX: number; startWidth: number } | null>(
    null,
  );

  function onHandleDown(e: React.PointerEvent, index: number) {
    // Stop the click reaching the header, or every resize also sorts.
    e.stopPropagation();
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { index, startX: e.clientX, startWidth: widths[index] };
  }

  function onHandleMove(e: React.PointerEvent) {
    const d = drag.current;
    if (!d) return;
    // Measured from where the drag started, never from the previous
    // frame: accumulating per-frame deltas drifts away from the pointer
    // as soon as one frame is dropped.
    const width = Math.max(MIN_WIDTH, d.startWidth + (e.clientX - d.startX));
    setWidths((current) => current.map((w, i) => (i === d.index ? width : w)));
  }

  function onHandleUp(e: React.PointerEvent) {
    if (drag.current === null) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    drag.current = null;
  }

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
                style={{ width: `${widths[i]}px` }}
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
                <span
                  className="col-resize"
                  onPointerDown={(e) => onHandleDown(e, i)}
                  onPointerMove={onHandleMove}
                  onPointerUp={onHandleUp}
                  onClick={(e) => {
                    // Releasing a drag fires a click, and `click` is
                    // synthesised from the mousedown/mouseup pair rather
                    // than bubbling from `pointerdown` — so stopping
                    // propagation there does not stop this. Without it
                    // every resize also sorted, and on a Data tab the
                    // sort re-ran the query and wiped the width just
                    // dragged.
                    e.stopPropagation();
                  }}
                  onDoubleClick={(e) => {
                    // Without this the double-click also cycles the sort
                    // twice on its way through the header.
                    e.stopPropagation();
                    setWidths((current) =>
                      current.map((w, index) =>
                        index === i
                          ? fitWidth(i, result.columns, result.rows)
                          : w,
                      ),
                    );
                  }}
                  onKeyDown={(e) => {
                    // Keyboard-first app: a column must be resizable
                    // without a pointer.
                    if (e.key === "ArrowLeft") setWidths((c) => resized(c, i, -16));
                    if (e.key === "ArrowRight") setWidths((c) => resized(c, i, 16));
                  }}
                  role="separator"
                  aria-orientation="vertical"
                  aria-label={`Resize ${c.name}`}
                  tabIndex={0}
                />
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
                    <td
                      key={i}
                      className={`cell-${kind}`}
                      style={{ width: `${widths[i]}px` }}
                      title={text}
                    >
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
