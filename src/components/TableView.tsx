import type { TableDetail } from "../lib/tableDetail";
import type { TableMode } from "../types";

interface Props {
  schemaName: string;
  tableName: string;
  /** Null when the table is not in the current schema. */
  detail: TableDetail | null;
  mode: TableMode;
  onModeChange: (mode: TableMode) => void;
  onRefreshSchema: () => void;
  /** Rendered under the toggle in data mode — the result grid. */
  children?: React.ReactNode;
}

export function TableView({
  schemaName,
  tableName,
  detail,
  mode,
  onModeChange,
  onRefreshSchema,
  children,
}: Props) {
  return (
    <div className="table-view">
      <header className="table-view-head">
        {/* Built from props, not `detail` — the header must still render
            the table's identity when `detail` is null (table not found). */}
        <span className="table-view-name">
          {schemaName}.{tableName}
        </span>
        <div className="segmented">
          <button
            className={mode === "structure" ? "active" : ""}
            onClick={() => onModeChange("structure")}
          >
            Structure
          </button>
          <button
            className={mode === "data" ? "active" : ""}
            onClick={() => onModeChange("data")}
          >
            Data
          </button>
        </div>
      </header>

      {mode === "data" ? (
        children
      ) : detail === null ? (
        <p className="table-view-empty">
          {schemaName}.{tableName} is not in this database.{" "}
          <button className="link" onClick={onRefreshSchema}>
            Refresh
          </button>
        </p>
      ) : (
        <div className="table-view-body">
          <section>
            <h3>Columns</h3>
            {detail.columns.length === 0 ? (
              <p className="none">None</p>
            ) : (
              <table className="detail-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Type</th>
                    <th>Nullable</th>
                    <th>Default</th>
                    <th>References</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.columns.map((c) => (
                    <tr key={c.name}>
                      <td>
                        {c.name}
                        {c.isPrimaryKey && <span className="marker pk">PK</span>}
                      </td>
                      <td className="mono">{c.type}</td>
                      <td>{c.nullableLabel}</td>
                      <td className="mono">{c.default ?? ""}</td>
                      <td className="mono">{c.referencesLabel ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section>
            <h3>Indexes</h3>
            {detail.indexes.length === 0 ? (
              <p className="none">None</p>
            ) : (
              <ul className="detail-list">
                {detail.indexes.map((i) => (
                  <li key={i.name}>
                    <span className="detail-name">{i.name}</span>
                    {i.badges.map((b) => (
                      <span key={b} className="marker">
                        {b}
                      </span>
                    ))}
                    <code>{i.definition}</code>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h3>Constraints</h3>
            {detail.constraints.length === 0 ? (
              <p className="none">None</p>
            ) : (
              detail.constraints.map((g) => (
                <div key={g.kind} className="constraint-group">
                  <h4>{g.label}</h4>
                  <ul className="detail-list">
                    {g.items.map((c) => (
                      <li key={c.name}>
                        <span className="detail-name">{c.name}</span>
                        <code>{c.definition}</code>
                      </li>
                    ))}
                  </ul>
                </div>
              ))
            )}
          </section>
        </div>
      )}
    </div>
  );
}
