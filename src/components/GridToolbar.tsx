export type ExportFormat = "csv" | "json" | "sql";

interface Props {
  /**
   * SQL INSERT is offered only where the target table is genuinely
   * known — a table Data tab. A join or expression query has no single
   * target, so the option is absent rather than disabled.
   */
  canExportSql: boolean;
  busy: boolean;
  onExport: (format: ExportFormat) => void;
  /**
   * Whether the selected row can be staged for deletion. The button is
   * disabled rather than absent when nothing is selected, so the
   * affordance stays discoverable.
   */
  canDelete: boolean;
  /** Whether that row is already staged, so the button can undo it. */
  deleting: boolean;
  onDeleteRow: () => void;
}

export function GridToolbar({
  canExportSql,
  busy,
  onExport,
  canDelete,
  deleting,
  onDeleteRow,
}: Props) {
  return (
    <div className="grid-toolbar">
      <span className="grid-toolbar-label">Export</span>
      <button disabled={busy} onClick={() => onExport("csv")}>
        CSV
      </button>
      <button disabled={busy} onClick={() => onExport("json")}>
        JSON
      </button>
      {canExportSql && (
        <button disabled={busy} onClick={() => onExport("sql")}>
          SQL
        </button>
      )}
      <span className="grid-toolbar-gap" />
      <button
        className="danger"
        disabled={busy || !canDelete}
        title={
          canDelete
            ? "Shift+Cmd+Backspace"
            : "select a row in an editable result to delete it"
        }
        onClick={onDeleteRow}
      >
        {deleting ? "Undo delete" : "Delete row"}
      </button>
    </div>
  );
}
