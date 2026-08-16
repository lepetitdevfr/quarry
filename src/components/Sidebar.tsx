import { QueryTree, type Creating } from "./QueryTree";
import { SchemaTree } from "./SchemaTree";
import type { LibraryTree, Schema } from "../types";

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
  onTableDoubleClick: (schema: string, table: string) => void;
  onTableClick: (schema: string, table: string) => void;
}

export function Sidebar(props: Props) {
  return (
    <aside className="sidebar">
      <section className="sidebar-section schema">
        <header className="sidebar-header">
          <span>SCHEMA</span>
        </header>
        <SchemaTree
          schema={props.schema}
          loading={props.schemaLoading}
          error={props.schemaError}
          connected={props.connected}
          onRefresh={props.onRefreshSchema}
          onTableDoubleClick={props.onTableDoubleClick}
          onTableClick={props.onTableClick}
        />
      </section>

      <div className="sidebar-splitter" />

      <section className="sidebar-section queries">
        <header className="sidebar-header">
          <span>QUERIES</span>
          <div className="sidebar-header-actions">
            <button
              className="row-action"
              title="New query"
              onClick={props.onNewQuery}
            >
              + Query
            </button>
            <button
              className="row-action"
              title="New collection"
              onClick={props.onNewCollection}
            >
              + Folder
            </button>
          </div>
        </header>
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
      </section>
    </aside>
  );
}
