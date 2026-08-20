import { useCallback, useRef, useState } from "react";
import { PaneResizer } from "./PaneResizer";
import { QueryTree, type Creating } from "./QueryTree";
import { RecentList } from "./RecentList";
import { SchemaTree } from "./SchemaTree";
import { DEFAULT_SCHEMA_HEIGHT, clampSectionHeight } from "../lib/layout";
import type { Connection, LibraryTree, RecentItem, Schema } from "../types";

interface Props {
  library: LibraryTree;
  activeQueryId: string | null;
  onOpen: (queryId: string) => void;
  onNewQuery: () => void;
  onNewCollection: () => void;
  onNewQueryInCollection: (collectionId: string) => void;
  onRenameQuery: (id: string, name: string) => void;
  onDeleteQuery: (id: string) => void;
  onMoveQuery: (id: string, collectionId: string | null) => void;
  onRenameCollection: (id: string, name: string) => void;
  onDeleteCollection: (id: string) => void;
  creating: Creating | null;
  onCommitCreate: (name: string) => void;
  onCancelCreate: () => void;
  schema: Schema | null;
  schemaLoading: boolean;
  schemaError: string | null;
  connected: boolean;
  onRefreshSchema: () => void;
  onOpenTableData: (schema: string, table: string) => void;
  onOpenTableStructure: (schema: string, table: string) => void;
  /** The table the active tab is showing, so the tree can mark it. */
  activeTable: { schema: string; table: string } | null;
  /** Everything run or closed, newest first. */
  recent: RecentItem[];
  connections: Connection[];
  activeConnectionId: string | null;
  onOpenRecent: (sql: string) => void;
  onForgetRecent: (id: string) => void;
}

export function Sidebar(props: Props) {
  // The schema section is the measured one; the query tree takes what is
  // left. Measuring both would have them fight over the remainder.
  const [schemaHeight, setSchemaHeight] = useState(DEFAULT_SCHEMA_HEIGHT);
  const shellRef = useRef<HTMLElement>(null);

  // Queries and History share the bottom section rather than stacking.
  // A third stacked section would need a second resizer and three-way
  // height maths in a sidebar that is already tight — and the two are
  // alternatives, not competitors: you are either browsing work you
  // saved or recovering work you did not.
  const [bottom, setBottom] = useState<"queries" | "history">("queries");

  const resize = useCallback((clientY: number) => {
    const shell = shellRef.current;
    if (!shell) return;
    const { top, height } = shell.getBoundingClientRect();
    setSchemaHeight(clampSectionHeight(clientY - top, height));
  }, []);

  const nudge = useCallback((delta: number) => {
    const shell = shellRef.current;
    if (!shell) return;
    const { height } = shell.getBoundingClientRect();
    setSchemaHeight((current) => clampSectionHeight(current + delta, height));
  }, []);

  return (
    <aside className="sidebar" ref={shellRef}>
      <section
        className="sidebar-section schema sized"
        style={{ height: schemaHeight }}
      >
        <header className="sidebar-header">
          <span className="overline">Schema</span>
        </header>
        <SchemaTree
          schema={props.schema}
          loading={props.schemaLoading}
          error={props.schemaError}
          connected={props.connected}
          onRefresh={props.onRefreshSchema}
          onOpenData={props.onOpenTableData}
          onOpenStructure={props.onOpenTableStructure}
          activeTable={props.activeTable}
        />
      </section>

      <PaneResizer
        className="sidebar-splitter"
        label="Resize schema section"
        onDrag={resize}
        onNudge={nudge}
      />

      <section className="sidebar-section queries">
        <header className="sidebar-header">
          <div className="section-tabs">
            <button
              className={bottom === "queries" ? "overline active" : "overline"}
              onClick={() => setBottom("queries")}
            >
              Queries
            </button>
            <button
              className={bottom === "history" ? "overline active" : "overline"}
              onClick={() => setBottom("history")}
            >
              History
            </button>
          </div>
          {/* Only the Queries list has anything to create. History is a
              record of what happened, not a place you add to. */}
          {bottom === "queries" && (
            <div className="sidebar-header-actions">
              <button
                className="row-action text"
                title="New query"
                onClick={props.onNewQuery}
              >
                + Query
              </button>
              <button
                className="row-action text"
                title="New folder"
                onClick={props.onNewCollection}
              >
                + Folder
              </button>
            </div>
          )}
        </header>
        {bottom === "queries" ? (
          <QueryTree
            library={props.library}
            activeQueryId={props.activeQueryId}
            onOpen={props.onOpen}
            onRenameQuery={props.onRenameQuery}
            onDeleteQuery={props.onDeleteQuery}
            onMoveQuery={props.onMoveQuery}
            onRenameCollection={props.onRenameCollection}
            onDeleteCollection={props.onDeleteCollection}
            onNewQueryInCollection={props.onNewQueryInCollection}
            creating={props.creating}
            onCommitCreate={props.onCommitCreate}
            onCancelCreate={props.onCancelCreate}
          />
        ) : (
          <RecentList
            items={props.recent}
            connections={props.connections}
            activeConnectionId={props.activeConnectionId}
            onOpen={props.onOpenRecent}
            onForget={props.onForgetRecent}
          />
        )}
      </section>
    </aside>
  );
}
