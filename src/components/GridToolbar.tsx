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
}

export function GridToolbar({ canExportSql, busy, onExport }: Props) {
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
    </div>
  );
}
