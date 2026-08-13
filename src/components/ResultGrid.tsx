import { useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { formatCell } from "../lib/format";
import type { QueryResult } from "../types";

interface Props {
  result: QueryResult;
}

const ROW_HEIGHT = 28;

export function ResultGrid({ result }: Props) {
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

  return (
    <div className="result-grid" ref={scrollRef}>
      <table>
        <thead>
          <tr>
            {result.columns.map((c, i) => (
              // Column names can repeat (e.g. `SELECT 1 as n, 2 as n`), so
              // the index is used as the key instead of the name.
              <th key={i} title={c.type_name}>
                {c.name}
                <span className="col-type">{c.type_name}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody style={{ height: `${virtualizer.getTotalSize()}px` }}>
          {virtualizer.getVirtualItems().map((item) => {
            const row = result.rows[item.index];
            return (
              <tr
                key={item.key}
                style={{
                  position: "absolute",
                  transform: `translateY(${item.start}px)`,
                  height: `${ROW_HEIGHT}px`,
                }}
              >
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
