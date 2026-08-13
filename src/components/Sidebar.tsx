import { QueryTree } from "./QueryTree";
import type { LibraryTree } from "../types";

interface Props {
  library: LibraryTree;
  activeQueryId: string | null;
  onOpen: (queryId: string) => void;
  onNewCollection: () => void;
  onRenameQuery: (id: string, name: string) => void;
  onDeleteQuery: (id: string) => void;
  onRenameCollection: (id: string, name: string) => void;
  onDeleteCollection: (id: string) => void;
}

export function Sidebar(props: Props) {
  return (
    <aside className="sidebar">
      <section className="sidebar-section schema">
        <header className="sidebar-header">
          <span>SCHEMA</span>
        </header>
        <p className="tree-empty">Schema browsing arrives in Stage 4.</p>
      </section>

      <div className="sidebar-splitter" />

      <section className="sidebar-section queries">
        <header className="sidebar-header">
          <span>QUERIES</span>
          <button
            className="row-action"
            title="New collection"
            onClick={props.onNewCollection}
          >
            +
          </button>
        </header>
        <QueryTree
          library={props.library}
          activeQueryId={props.activeQueryId}
          onOpen={props.onOpen}
          onRenameQuery={props.onRenameQuery}
          onDeleteQuery={props.onDeleteQuery}
          onRenameCollection={props.onRenameCollection}
          onDeleteCollection={props.onDeleteCollection}
        />
      </section>
    </aside>
  );
}
