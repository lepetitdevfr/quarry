import { useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { toTsv } from "../lib/exportRows";
import { formatCell } from "../lib/format";
import {
  isSelected,
  movedCell,
  selectAll,
  selectionRange,
} from "../lib/gridSelection";
import type { CellRef, SelectionRange } from "../lib/gridSelection";
import { ContextMenu, useContextMenu, type MenuItem } from "./ContextMenu";
import { isTruncated, nextSort, sortedIndices } from "../lib/gridSort";
import type { SortState } from "../lib/gridSort";
import {
  MIN_WIDTH,
  columnsKey,
  fitWidth,
  initialWidths,
  resized,
} from "../lib/gridWidths";
import {
  cellText,
  editorSeed,
  insertValue,
  isDeleted,
  isPending,
  pendingValue,
} from "../lib/pendingEdits";
import type {
  Pending,
  PendingDeletes,
  PendingInserts,
} from "../lib/pendingEdits";
import type { ColumnEdit, QueryResult } from "../types";

/**
 * What an untouched cell on a new row will become.
 *
 * `default` and `NULL` are different promises, and the column's own
 * metadata is the only thing that knows which one applies.
 */
function placeholderFor(columnEdit: ColumnEdit | undefined): string {
  if (!columnEdit || columnEdit.insertable === false) return "generated";
  return columnEdit.has_default ? "default" : "NULL";
}

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
  /** Staged row deletions, or null when editing is off entirely. */
  deletes: PendingDeletes | null;
  onToggleDelete: (row: number) => void;
  /** Staged new rows, or null when editing is off entirely. */
  inserts: PendingInserts | null;
  onInsertRow: () => void;
  onInsertCell: (id: number, column: number, value: string | null) => void;
  onRemoveInsert: (id: number) => void;
  /**
   * The selected row, as an index into `result.rows`, or null when
   * nothing is selected. Reported upwards because the Delete row button
   * lives in the toolbar, outside this component.
   */
  onSelectRow: (row: number | null) => void;
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
  deletes,
  onToggleDelete,
  inserts,
  onInsertRow,
  onInsertCell,
  onRemoveInsert,
  onSelectRow,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Measured, because the staged rows pin directly beneath the header
  // and their `top` is exactly its height — which depends on the font
  // and the type scale, so it cannot be a constant. Observed rather
  // than measured once: the header grows when a column name wraps or
  // the type scale changes.
  const headRef = useRef<HTMLTableSectionElement>(null);
  const [headHeight, setHeadHeight] = useState(0);
  useEffect(() => {
    const head = headRef.current;
    if (!head) return;
    const observer = new ResizeObserver(() =>
      setHeadHeight(head.getBoundingClientRect().height),
    );
    observer.observe(head);
    return () => observer.disconnect();
  }, []);

  // Staged rows are rendered above the fetched ones, so the virtual
  // list no longer starts at the top of the scroll container. Every
  // staged row is one ROW_HEIGHT of scroll offset the virtualizer would
  // otherwise attribute to the list, leaving the window it mounts that
  // far out of step with what is on screen.
  const stagedCount = inserts?.length ?? 0;

  // Only the visible rows are mounted. Without this a 100k-row result
  // creates 100k DOM nodes and the window stops responding.
  const virtualizer = useVirtualizer({
    count: result.rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
    scrollMargin: stagedCount * ROW_HEIGHT,
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
  const { menu, open: openMenu, close: closeMenu } = useContextMenu();

  // Which cell is open for editing, and the text currently in it.
  const [editing, setEditing] = useState<{ row: number; col: number } | null>(
    null,
  );
  const [draft, setDraft] = useState("");

  // The same, for a cell on a staged new row. Keyed by the staged row's
  // id rather than its position, so discarding an earlier staged row
  // cannot re-point an open editor at a different one.
  const [editingInsert, setEditingInsert] = useState<{
    id: number;
    col: number;
  } | null>(null);
  const [insertDraft, setInsertDraft] = useState("");

  const columnEdits = result.edit.columns;

  function canEdit(col: number): boolean {
    return pending !== null && (columnEdits[col]?.editable ?? false);
  }

  function openEditor(row: number, col: number) {
    if (!canEdit(col)) return;
    const staged = pendingValue(pending!, row, col);
    setDraft(
      editorSeed(
        columnEdits[col],
        staged !== undefined ? (staged ?? "") : cellText(result.rows[row][col]),
      ),
    );
    setEditing({ row, col });
  }

  function commit() {
    if (editing === null) return;
    onStage(editing.row, editing.col, draft);
    setEditing(null);
  }

  function openInsertEditor(id: number, col: number, current: string) {
    setInsertDraft(editorSeed(columnEdits[col], current));
    setEditingInsert({ id, col });
  }

  function commitInsert() {
    if (editingInsert === null) return;
    onInsertCell(editingInsert.id, editingInsert.col, insertDraft);
    setEditingInsert(null);
  }

  /**
   * The open editor for one cell.
   *
   * One function for both the existing rows and the staged ones: two
   * copies of this branch would drift, and the column that offers a
   * list of values offers it wherever it appears.
   *
   * A native `<select>` brings type-ahead, Enter-commits and
   * Esc-cancels for free, which is why enum and boolean columns get one
   * rather than a custom listbox.
   */
  function renderEditor(
    columnEdit: ColumnEdit | undefined,
    value: string,
    setValue: (next: string) => void,
    onCommit: () => void,
    onCancel: () => void,
  ) {
    const shared = {
      className: "cell-editor",
      autoFocus: true,
      value,
      onBlur: onCommit,
    };

    if (columnEdit?.choices) {
      return (
        <select
          {...shared}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onCommit();
            }
            if (e.key === "Escape") {
              e.preventDefault();
              onCancel();
            }
          }}
        >
          {columnEdit.choices.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      );
    }

    return (
      <input
        {...shared}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onCommit();
          }
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
          if (e.key === "Tab") {
            e.preventDefault();
            onCommit();
          }
          // The grid's document-level Cmd+C/Cmd+A handler already skips
          // inputs, so nothing more is needed here.
        }}
      />
    );
  }

  // A rectangle into a result that no longer exists means nothing.
  useEffect(() => {
    setAnchor(null);
    setFocus(null);
    setSelectedAll(null);
    setEditing(null);
    setEditingInsert(null);
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

  // The anchor is a display position, so the row it names changes when
  // the grid is re-sorted. Deriving the underlying index on every render
  // — rather than storing it when the click happens — is what keeps the
  // toolbar's Delete row button pointed at the row you can see.
  const selectedRow = anchor ? (order[anchor.row] ?? null) : null;
  useEffect(() => {
    onSelectRow(selectedRow);
    // `onSelectRow` is a fresh arrow on every parent render; watching it
    // would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRow]);

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

      // Shift+Cmd+N stages a blank row. Cmd+N is untouched by menu.rs,
      // which claims only CmdOrCtrl+W and Shift+CmdOrCtrl+W.
      if (e.shiftKey && e.key.toLowerCase() === "n" && inserts !== null) {
        e.preventDefault();
        onInsertRow();
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
    // `order` is a fresh array every render, so this already re-subscribes
    // on each one; listing `inserts` and `onInsertRow` costs nothing and
    // keeps the Shift+Cmd+N branch off a stale closure.
  }, [range, order, result, inserts, onInsertRow]);

  /**
   * Move the selection with the arrow keys.
   *
   * Positions here are display positions, the same ones the selection
   * rectangle uses, so this keeps working when the grid is sorted.
   * Shift extends from the existing anchor instead of moving it, which
   * is the one behaviour that makes a keyboard selection worth having.
   */
  function moveSelection(
    rowDelta: number,
    colDelta: number,
    extend: boolean,
    origin: CellRef,
  ) {
    setSelectedAll(null);
    const base = extend ? (focus ?? origin) : origin;
    const next = movedCell(
      base,
      rowDelta,
      colDelta,
      result.rows.length,
      result.columns.length,
    );
    if (!extend) setAnchor(next);
    setFocus(next);
    virtualizer.scrollToIndex(next.row);
    // The cell has to take focus for the next arrow key to land here
    // rather than on the body, and the row may not be mounted yet.
    requestAnimationFrame(() => {
      scrollRef.current
        ?.querySelector<HTMLTableCellElement>(
          `[data-cell="${next.row}-${next.col}"]`,
        )
        ?.focus();
    });
  }

  /** The right-click menu for one cell. */
  function cellMenu(rowIndex: number, col: number): MenuItem[] {
    const editable = canEdit(col);
    const staged = deletes !== null && isDeleted(deletes, rowIndex);
    return [
      {
        label: "Copy",
        shortcut: "⌘C",
        // The value on screen, staged edit included. Copying the
        // database value from a cell showing something else would be
        // the one place in this grid where what you see is not what you
        // get.
        onSelect: () => {
          const staged = pending
            ? pendingValue(pending, rowIndex, col)
            : undefined;
          void navigator.clipboard.writeText(
            formatCell(staged !== undefined ? staged : result.rows[rowIndex][col])
              .text,
          );
        },
      },
      {
        label: "Copy row",
        onSelect: () =>
          void navigator.clipboard.writeText(
            toTsv(result.columns, [result.rows[rowIndex]], false),
          ),
      },
      { separator: true },
      {
        label: "Edit cell…",
        shortcut: "↵",
        disabled: !editable,
        title: editable ? undefined : (columnEdits[col]?.reason ?? undefined),
        onSelect: () => openEditor(rowIndex, col),
      },
      {
        label: "Set NULL",
        shortcut: "⌘⌫",
        disabled: !editable,
        title: editable ? undefined : (columnEdits[col]?.reason ?? undefined),
        onSelect: () => onStage(rowIndex, col, null),
      },
      { separator: true },
      {
        label: "Insert row",
        shortcut: "⇧⌘N",
        disabled: inserts === null,
        onSelect: onInsertRow,
      },
      {
        label: staged ? "Undo delete row" : "Delete row",
        shortcut: "⇧⌘⌫",
        danger: !staged,
        disabled: deletes === null,
        onSelect: () => onToggleDelete(rowIndex),
      },
    ];
  }

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
        <thead ref={headRef}>
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
        {/* Staged rows sit in their own tbody, outside both the virtual
            window and `order[]`: they are not in the database, so there
            is nothing to sort them by and nothing to scroll past —
            there are only ever a handful.

            Above the fetched rows rather than below them. A new row
            appended after the last of five hundred is a new row you
            cannot see: you press ⇧⌘N, nothing appears to happen, and
            the only evidence is the count in the edit bar. At the top
            it is next to the header, where the thing you just created
            is the first thing you look at. */}
        {inserts !== null && inserts.length > 0 && (
          <tbody className="staged" style={{ top: `${headHeight}px` }}>
            {inserts.map((staged) => (
              // The same height as a fetched row, both because a staged
              // row is a row and because `scrollMargin` above counts
              // them in ROW_HEIGHTs.
              <tr
                className="inserting"
                key={`insert-${staged.id}`}
                style={{ height: `${ROW_HEIGHT}px` }}
              >
                <td className="row-num">+</td>
                {result.columns.map((_, i) => {
                  const columnEdit = columnEdits[i];
                  const value = insertValue(inserts, staged.id, i);
                  const canFill = columnEdit?.insertable ?? false;
                  const isEditingCell =
                    editingInsert?.id === staged.id && editingInsert?.col === i;

                  return (
                    <td
                      key={i}
                      className={[
                        value === undefined
                          ? "cell-placeholder"
                          : `cell-${formatCell(value).kind}`,
                        canFill ? "" : "not-editable",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      style={{ width: `${widths[i]}px` }}
                      title={
                        canFill ? undefined : (columnEdit?.insert_reason ?? undefined)
                      }
                      tabIndex={canFill ? 0 : undefined}
                      onDoubleClick={() =>
                        canFill && openInsertEditor(staged.id, i, value ?? "")
                      }
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !isEditingCell && canFill) {
                          e.preventDefault();
                          openInsertEditor(staged.id, i, value ?? "");
                        }
                        // Discards the staged row outright: it never
                        // existed, so there is nothing to ask the server
                        // about.
                        if (
                          (e.metaKey || e.ctrlKey) &&
                          e.shiftKey &&
                          e.key === "Backspace"
                        ) {
                          e.preventDefault();
                          onRemoveInsert(staged.id);
                          return;
                        }
                        // An explicit NULL, which overrides a default
                        // rather than accepting it.
                        if (
                          (e.metaKey || e.ctrlKey) &&
                          !e.shiftKey &&
                          e.key === "Backspace" &&
                          canFill
                        ) {
                          e.preventDefault();
                          onInsertCell(staged.id, i, null);
                        }
                      }}
                    >
                      {isEditingCell
                        ? renderEditor(
                            columnEdit,
                            insertDraft,
                            setInsertDraft,
                            commitInsert,
                            () => setEditingInsert(null),
                          )
                        : value === undefined
                          ? placeholderFor(columnEdit)
                          : formatCell(value).text}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        )}
        <tbody style={{ height: `${virtualizer.getTotalSize()}px` }}>
          {virtualizer.getVirtualItems().map((item) => {
            const row = result.rows[order[item.index]];
            return (
              <tr
                key={item.key}
                className={
                  deletes && isDeleted(deletes, order[item.index])
                    ? "deleted"
                    : undefined
                }
                style={{
                  position: "absolute",
                  // `item.start` is measured from the top of the scroll
                  // container, so it includes `scrollMargin` — while
                  // these rows are positioned against a tbody that
                  // already begins below the staged block. Without the
                  // subtraction every row sits one staged row too low,
                  // leaving a gap under the staged block exactly its
                  // own height. `getTotalSize` already nets it out, so
                  // the tbody's height needs no such correction.
                  transform: `translateY(${item.start - virtualizer.options.scrollMargin}px)`,
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
                      data-cell={`${item.index}-${i}`}
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
                      onContextMenu={(e) => {
                        // Right-clicking outside the current selection
                        // moves it first, so the menu always acts on the
                        // cell under the pointer.
                        if (!isSelected(range, item.index, i)) {
                          setSelectedAll(null);
                          setAnchor({ row: item.index, col: i });
                          setFocus({ row: item.index, col: i });
                        }
                        openMenu(e, cellMenu(rowIndex, i));
                      }}
                      onKeyDown={(e) => {
                        // Arrow keys move the selection; Shift extends
                        // it. Without this the grid could only be
                        // selected with a pointer, which for a
                        // keyboard-first app is the wrong way round.
                        const origin = { row: item.index, col: i };
                        if (!isEditingCell && !e.metaKey && !e.ctrlKey) {
                          const step: Record<string, [number, number]> = {
                            ArrowDown: [1, 0],
                            ArrowUp: [-1, 0],
                            ArrowRight: [0, 1],
                            ArrowLeft: [0, -1],
                            PageDown: [20, 0],
                            PageUp: [-20, 0],
                          };
                          const delta = step[e.key];
                          if (delta) {
                            e.preventDefault();
                            moveSelection(delta[0], delta[1], e.shiftKey, origin);
                            return;
                          }
                          if (e.key === "Escape") {
                            e.preventDefault();
                            setAnchor(null);
                            setFocus(null);
                            setSelectedAll(null);
                            return;
                          }
                        }
                        if (e.key === "Enter" && !isEditingCell) {
                          e.preventDefault();
                          openEditor(rowIndex, i);
                        }
                        // Shift+Cmd+Backspace stages the whole row for
                        // deletion. Checked before the plain chord, and
                        // the plain chord excludes Shift, so the two
                        // cannot both fire. Not plain Backspace, which
                        // would make one stray keypress destructive.
                        if (
                          (e.metaKey || e.ctrlKey) &&
                          e.shiftKey &&
                          e.key === "Backspace" &&
                          deletes !== null
                        ) {
                          e.preventDefault();
                          onToggleDelete(rowIndex);
                          return;
                        }
                        // Cmd+Backspace stages an explicit SQL NULL.
                        // Typing nothing means the empty string, which
                        // is a different value — the grid has always
                        // rendered the two differently and editing must
                        // keep them apart.
                        if (
                          (e.metaKey || e.ctrlKey) &&
                          !e.shiftKey &&
                          e.key === "Backspace" &&
                          canEdit(i)
                        ) {
                          e.preventDefault();
                          onStage(rowIndex, i, null);
                        }
                      }}
                      // Roving tab stop: one cell in the grid is
                      // tabbable, and the arrow keys move which. Making
                      // every editable cell a tab stop meant Tab walked
                      // a 500-row result one cell at a time, and made a
                      // read-only result unreachable from the keyboard
                      // altogether.
                      tabIndex={
                        (focus ?? anchor)
                          ? focus?.row === item.index && focus?.col === i
                            ? 0
                            : -1
                          : item.index === 0 && i === 0
                            ? 0
                            : -1
                      }
                    >
                      {isEditingCell
                        ? renderEditor(columnEdit, draft, setDraft, commit, () =>
                            setEditing(null),
                          )
                        : text}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>

      {/* A result with columns and no rows used to be a sticky header
          over an empty scroll area, which reads as "still loading"
          rather than "that query matched nothing". The header stays —
          the column list is still the answer to half the question. */}
      {result.rows.length === 0 &&
        (inserts === null || inserts.length === 0) && (
          <p className="grid-empty">No rows.</p>
        )}

      <ContextMenu menu={menu} onClose={closeMenu} />
    </div>
  );
}
