import { useEffect, useState } from "react";
import { RenameInput } from "./RenameInput";
import { buildTree, isDirty, moveTargets } from "../lib/tree";
import type { LibraryTree, Query, TreeNode } from "../types";

/** What is currently being named — a brand-new query or collection,
 * not yet persisted. `parentId` is the collection it will live in
 * (null for the top level). */
export interface Creating {
  kind: "query" | "collection";
  parentId: string | null;
}

interface Props {
  library: LibraryTree;
  activeQueryId: string | null;
  onOpen: (queryId: string) => void;
  onRenameQuery: (id: string, name: string) => void;
  onDeleteQuery: (id: string) => void;
  onMoveQuery: (id: string, collectionId: string | null) => void;
  onRenameCollection: (id: string, name: string) => void;
  onDeleteCollection: (id: string) => void;
  onNewQueryInCollection: (collectionId: string) => void;
  creating: Creating | null;
  onCommitCreate: (name: string) => void;
  onCancelCreate: () => void;
}

export function QueryTree({
  library,
  activeQueryId,
  onOpen,
  onRenameQuery,
  onDeleteQuery,
  onMoveQuery,
  onRenameCollection,
  onDeleteCollection,
  onNewQueryInCollection,
  creating,
  onCommitCreate,
  onCancelCreate,
}: Props) {
  const { roots, looseQueries } = buildTree(library);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<string | null>(null);
  // Which query's move menu is open. One at a time: two open menus in a
  // narrow sidebar cover the tree they are meant to move things within.
  const [moving, setMoving] = useState<string | null>(null);

  // A menu that survives a click elsewhere reads as stuck. Mousedown
  // rather than click, so it closes on the press that starts an action
  // somewhere else rather than after it completes.
  useEffect(() => {
    if (moving === null) return;
    const close = () => setMoving(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMoving(null);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [moving]);

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
    const targets = moveTargets(library, query);

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
          title="Move to…"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            setMoving((open) => (open === query.id ? null : query.id));
          }}
        >
          ⋯
        </button>
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

        {moving === query.id && (
          <div
            className="move-menu"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            {targets.length === 0 ? (
              // Nowhere to go: one collection that the query already
              // lives in, or none at all. Saying so beats an empty box.
              <span className="move-empty">No other collection</span>
            ) : (
              targets.map((target) => (
                <button
                  key={target.id ?? "root"}
                  className="move-option"
                  onClick={() => {
                    onMoveQuery(query.id, target.id);
                    setMoving(null);
                  }}
                >
                  {target.label}
                </button>
              ))
            )}
          </div>
        )}
      </div>
    );
  }

  function renderNode(node: TreeNode, depth: number) {
    const isCollapsed = collapsed.has(node.collection.id);
    const creatingHere = creating?.kind === "query" && creating.parentId === node.collection.id;

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
              title="New query in this collection"
              onClick={(e) => {
                e.stopPropagation();
                onNewQueryInCollection(node.collection.id);
              }}
            >
              +
            </button>
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
            {creatingHere && (
              <RenameInput
                initial=""
                depth={depth + 1}
                placeholder="Query name"
                onCommit={onCommitCreate}
                onCancel={onCancelCreate}
              />
            )}
          </>
        )}
      </div>
    );
  }

  const creatingAtRoot = creating !== null && creating.parentId === null;

  if (roots.length === 0 && looseQueries.length === 0 && !creatingAtRoot) {
    return <p className="tree-empty">No saved queries yet.</p>;
  }

  return (
    <div className="query-tree">
      {roots.map((node) => renderNode(node, 0))}
      {looseQueries.map((query) => renderQuery(query, 0))}
      {creatingAtRoot && (
        <RenameInput
          initial=""
          depth={0}
          placeholder={creating.kind === "collection" ? "Collection name" : "Query name"}
          onCommit={onCommitCreate}
          onCancel={onCancelCreate}
        />
      )}
    </div>
  );
}
