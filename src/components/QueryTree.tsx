import { useState } from "react";
import { buildTree, isDirty } from "../lib/tree";
import type { LibraryTree, Query, TreeNode } from "../types";

interface Props {
  library: LibraryTree;
  activeQueryId: string | null;
  onOpen: (queryId: string) => void;
  onRenameQuery: (id: string, name: string) => void;
  onDeleteQuery: (id: string) => void;
  onRenameCollection: (id: string, name: string) => void;
  onDeleteCollection: (id: string) => void;
}

export function QueryTree({
  library,
  activeQueryId,
  onOpen,
  onRenameQuery,
  onDeleteQuery,
  onRenameCollection,
  onDeleteCollection,
}: Props) {
  const { roots, looseQueries } = buildTree(library);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<string | null>(null);

  function toggle(id: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function renderQuery(query: Query, depth: number) {
    const active = query.id === activeQueryId;
    const dirty = isDirty(query);

    if (renaming === query.id) {
      return (
        <RenameInput
          key={query.id}
          initial={query.name}
          depth={depth}
          onCommit={(name) => {
            onRenameQuery(query.id, name);
            setRenaming(null);
          }}
          onCancel={() => setRenaming(null)}
        />
      );
    }

    return (
      <div
        key={query.id}
        className={`tree-row query${active ? " active" : ""}`}
        style={{ paddingLeft: 8 + depth * 12 }}
        onClick={() => onOpen(query.id)}
        onDoubleClick={() => setRenaming(query.id)}
      >
        <span className="tree-name">{query.name}</span>
        {dirty && <span className="dirty-dot" title="unsaved changes">•</span>}
        <button
          className="row-action"
          title="Delete query"
          onClick={(e) => {
            e.stopPropagation();
            onDeleteQuery(query.id);
          }}
        >
          ×
        </button>
      </div>
    );
  }

  function renderNode(node: TreeNode, depth: number) {
    const isCollapsed = collapsed.has(node.collection.id);

    return (
      <div key={node.collection.id}>
        {renaming === node.collection.id ? (
          <RenameInput
            initial={node.collection.name}
            depth={depth}
            onCommit={(name) => {
              onRenameCollection(node.collection.id, name);
              setRenaming(null);
            }}
            onCancel={() => setRenaming(null)}
          />
        ) : (
          <div
            className="tree-row collection"
            style={{ paddingLeft: 8 + depth * 12 }}
            onClick={() => toggle(node.collection.id)}
            onDoubleClick={() => setRenaming(node.collection.id)}
          >
            <span className="chevron">{isCollapsed ? "▸" : "▾"}</span>
            <span className="tree-name">{node.collection.name}</span>
            <button
              className="row-action"
              title="Delete collection and everything in it"
              onClick={(e) => {
                e.stopPropagation();
                onDeleteCollection(node.collection.id);
              }}
            >
              ×
            </button>
          </div>
        )}

        {!isCollapsed && (
          <>
            {node.children.map((child) => renderNode(child, depth + 1))}
            {node.queries.map((query) => renderQuery(query, depth + 1))}
          </>
        )}
      </div>
    );
  }

  if (roots.length === 0 && looseQueries.length === 0) {
    return <p className="tree-empty">No saved queries yet.</p>;
  }

  return (
    <div className="query-tree">
      {roots.map((node) => renderNode(node, 0))}
      {looseQueries.map((query) => renderQuery(query, 0))}
    </div>
  );
}

/** Inline rename field. Enter commits, Escape cancels, blur commits. */
function RenameInput({
  initial,
  depth,
  onCommit,
  onCancel,
}: {
  initial: string;
  depth: number;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);

  return (
    <input
      className="rename-input"
      style={{ marginLeft: 8 + depth * 12 }}
      value={value}
      autoFocus
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => (value.trim() ? onCommit(value) : onCancel())}
      onKeyDown={(e) => {
        if (e.key === "Enter" && value.trim()) onCommit(value);
        if (e.key === "Escape") onCancel();
      }}
    />
  );
}
