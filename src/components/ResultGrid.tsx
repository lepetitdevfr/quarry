import { useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { toTsv } from "../lib/exportRows";
import { formatCell } from "../lib/format";
import { isSelected, selectAll, selectionRange } from "../lib/gridSelection";
import type { CellRef, SelectionRange } from "../lib/gridSelection";
import { isTruncated, nextSort, sortedIndices } from "../lib/gridSort";
import type { SortState } from "../lib/gridSort";
import {
  MIN_WIDTH,
  columnsKey,
  fitWidth,
  initialWidths,
  resized,
} from "../lib/gridWidths";
import { cellText, isPending, pendingValue } from "../lib/pendingEdits";
import type { Pending } from "../lib/pendingEdits";
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
  /**
   * Staged edits, or null when editing is off entirely — a locked
   * connection, or a result that cannot be edited.
   */
  pending: Pending | null;
  onStage: (row: number, col: number, value: string | null) => void;
}

const ROW_HEIGHT = 28;

export function ResultGrid({
  result,
  sql,
  sort,
  onSortChange,
  serverSorted,
  pending,
  onStage,
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

  const [anchor, setAnchor] = useState<CellRef | null>(null);
  const [focus, setFocus] = useState<CellRef | null>(null);
  const [selectedAll, setSelectedAll] = useState<SelectionRange | null>(null);

  // Which cell is open for editing, and the text currently in it.
  const [editing, setEditing] = useState<{ row: number; col: number } | null>(
    null,
  );
  const [draft, setDraft] = useState("");

  const columnEdits = result.edit.columns;

  function canEdit(col: number): boolean {
    return pending !== null && (columnEdits[col]?.editable ?? false);
  }

  function openEditor(row: number, col: number) {
    if (!canEdit(col)) return;
    const staged = pendingValue(pending!, row, col);
    setDraft(
      staged !== undefined ? (staged ?? "") : cellText(result.rows[row][col]),
    );
    setEditing({ row, col });
  }

  function commit() {
    if (editing === null) return;
    onStage(editing.row, editing.col, draft);
    setEditing(null);
  }

  // A rectangle into a result that no longer exists means nothing.
  useEffect(() => {
    setAnchor(null);
    setFocus(null);
    setSelectedAll(null);
    setEditing(null);
    // `shape` is the same trigger the widths use.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape]);

  // Display order of the rows. Computed before the empty-result early
  // return because the copy effect below closes over it, and a hook may
  // not sit after a conditional return.
  const order = serverSorted
    ? result.rows.map((_, i) => i)
    : sortedIndices(result.rows, sort);

  const range =
    selectedAll ??
    (anchor && focus ? selectionRange(anchor, focus) : null);

  // Cmd+C copies the selection as TSV; Cmd+A selects everything.
  //
  // Listening on the document rather than on the grid container: the
  // container would only receive keys while it held focus, and clicking
  // a cell does not reliably focus it in WebKit — so copying silently
  // did nothing. Scoping to "there is a selection" instead of "we have
  // focus" is both more robust and closer to what the user means.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey)) return;

      // Never steal the shortcut from a text field — the SQL editor's
      // own copy must keep working.
      const target = e.target as HTMLElement | null;
      if (
        target?.closest(
          "input, textarea, [contenteditable='true'], .cm-editor",
        )
      ) {
        return;
      }

      if (e.key === "a") {
        e.preventDefault();
        setSelectedAll(selectAll(result.rows.length, result.columns.length));
        return;
      }

      if (e.key === "c") {
        // Only claim the copy when the grid actually has something
        // selected; otherwise leave it to the rest of the page.
        if (range === null) return;
        e.preventDefault();

        const copied = result.columns.slice(range.left, range.right + 1);
        const rows = order
          .slice(range.top, range.bottom + 1)
          .map((r) => result.rows[r].slice(range.left, range.right + 1));
        // Headers only when whole columns are covered — a header above a
        // three-row fragment is noise.
        const wholeColumns =
          range.top === 0 && range.bottom === result.rows.length - 1;

        void navigator.clipboard.writeText(toTsv(copied, rows, wholeColumns));
      }
    }

    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [range, order, result]);

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
                  // `item.index` is the display position; `rowIndex` is
                  // the position in `result.rows`. Staging uses the
                  // latter — sorting the grid must not redirect an edit
                  // to a different row — while the selection rectangle
                  // deliberately keeps using the display position.
                  const rowIndex = order[item.index];
                  const staged = pending
                    ? pendingValue(pending, rowIndex, i)
                    : undefined;
                  const shown = staged !== undefined ? staged : cell;
                  const { text, kind } = formatCell(shown);
                  const isEditingCell =
                    editing?.row === rowIndex && editing?.col === i;
                  const columnEdit = columnEdits[i];
                  const notEditable = pending !== null && !canEdit(i);

                  return (
                    <td
                      key={i}
                      className={[
                        `cell-${kind}`,
                        isSelected(range, item.index, i) ? "selected" : "",
                        pending && isPending(pending, rowIndex, i)
                          ? "pending"
                          : "",
                        notEditable ? "not-editable" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      style={{ width: `${widths[i]}px` }}
                      title={
                        notEditable ? (columnEdit?.reason ?? undefined) : text
                      }
                      onDoubleClick={() => openEditor(rowIndex, i)}
                      onClick={(e) => {
                        setSelectedAll(null);
                        const cellRef = { row: item.index, col: i };
                        // Shift extends from the existing anchor; a plain
                        // click starts a new selection.
                        if (e.shiftKey && anchor) setFocus(cellRef);
                        else {
                          setAnchor(cellRef);
                          setFocus(cellRef);
                        }
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !isEditingCell) {
                          e.preventDefault();
                          openEditor(rowIndex, i);
                        }
                        // Cmd+Backspace stages an explicit SQL NULL.
                        // Typing nothing means the empty string, which
                        // is a different value — the grid has always
                        // rendered the two differently and editing must
                        // keep them apart.
                        if (
                          (e.metaKey || e.ctrlKey) &&
                          e.key === "Backspace" &&
                          canEdit(i)
                        ) {
                          e.preventDefault();
                          onStage(rowIndex, i, null);
                        }
                      }}
                      tabIndex={canEdit(i) ? 0 : undefined}
                    >
                      {isEditingCell ? (
                        <input
                          className="cell-editor"
                          autoFocus
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          onBlur={commit}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              commit();
                            }
                            if (e.key === "Escape") {
                              e.preventDefault();
                              setEditing(null);
                            }
                            if (e.key === "Tab") {
                              e.preventDefault();
                              commit();
                            }
                            // The grid's document-level Cmd+C/Cmd+A
                            // handler already skips inputs, so nothing
                            // more is needed here.
                          }}
                        />
                      ) : (
                        text
                      )}
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
