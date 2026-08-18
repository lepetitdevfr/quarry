import { dependentLabel } from "../lib/tableDetail";
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
  /** Rendered above the grid in data mode — the SQL behind the rows. */
  editor?: React.ReactNode;
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
  editor,
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
        // The query is shown, not hidden behind the tab: a Data tab is a
        // SELECT like any other, and the fastest way to filter one row out
        // of a thousand is to edit the WHERE that is already there.
        <>
          {editor}
          {children}
        </>
      ) : detail === null ? (
        <p className="table-view-empty">
          {schemaName}.{tableName} is not in this database.{" "}
          <button className="link" onClick={onRefreshSchema}>
            Refresh
          </button>
        </p>
      ) : (
        <div className="table-view-body">
          {/* Facts first: size and row count are what you came for when
              you opened a table you already know the shape of. */}
          {(detail.facts || detail.comment) && (
            <section className="table-facts">
              {detail.facts && (
                <div className="fact-row">
                  <span className="fact">
                    <span className="overline">Rows</span>
                    {/* "estimated" is not decoration: this is
                        pg_class.reltuples, the planner's figure, and it
                        can be well out of date. */}
                    <span className="fact-value">{detail.facts.rows}</span>
                    <span className="fact-note">estimated</span>
                  </span>
                  <span className="fact">
                    <span className="overline">Size</span>
                    <span className="fact-value">{detail.facts.size}</span>
                    <span className="fact-note">with indexes</span>
                  </span>
                </div>
              )}
              {detail.comment && <p className="table-comment">{detail.comment}</p>}
            </section>
          )}

          <section>
            <h3 className="overline">Columns</h3>
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
            <h3 className="overline">Indexes</h3>
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
            <h3 className="overline">Triggers</h3>
            {detail.triggers.length === 0 ? (
              <p className="none">None</p>
            ) : (
              <ul className="detail-list">
                {detail.triggers.map((t) => (
                  <li key={t.name}>
                    <span className="detail-name">{t.name}</span>
                    <code>{t.definition}</code>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h3 className="overline">Used by</h3>
            {detail.dependents.length === 0 ? (
              <p className="none">No views read this table</p>
            ) : (
              <ul className="detail-list">
                {detail.dependents.map((d) => (
                  <li key={`${d.schema}.${d.name}`}>
                    <span className="detail-name">{dependentLabel(d)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h3 className="overline">Constraints</h3>
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
