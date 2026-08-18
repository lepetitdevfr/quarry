import { useState } from "react";
import { ContextMenu, useContextMenu, type MenuItem } from "./ContextMenu";
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
  const { menu, open: openMenu, close: closeMenu } = useContextMenu();

  function toggle(id: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /**
   * A query row's menu.
   *
   * "Move to…" used to be a `⋯` button opening a popover anchored to the
   * row, and Delete a second hover-only `×` beside it — two glyph
   * targets on a 26px row, neither reachable without a pointer. Both are
   * rows in here now, where they can be labelled and, in Delete's case,
   * marked as the destructive one.
   */
  function queryMenu(query: Query): MenuItem[] {
    const targets = moveTargets(library, query);
    return [
      { label: "Open", shortcut: "↵", onSelect: () => onOpen(query.id) },
      { label: "Rename…", shortcut: "F2", onSelect: () => setRenaming(query.id) },
      { separator: true },
      ...(targets.length === 0
        ? [
            {
              label: "Move to…",
              disabled: true,
              title: "No other folder to move this into",
              onSelect: () => {},
            },
          ]
        : targets.map((target) => ({
            label: `Move to ${target.label}`,
            onSelect: () => onMoveQuery(query.id, target.id),
          }))),
      { separator: true },
      {
        label: "Delete query",
        danger: true,
        onSelect: () => onDeleteQuery(query.id),
      },
    ];
  }

  function collectionMenu(id: string): MenuItem[] {
    return [
      { label: "New query here", onSelect: () => onNewQueryInCollection(id) },
      { label: "Rename…", shortcut: "F2", onSelect: () => setRenaming(id) },
      { separator: true },
      {
        label: "Delete folder",
        danger: true,
        onSelect: () => onDeleteCollection(id),
      },
    ];
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
        role="treeitem"
        aria-selected={active}
        tabIndex={0}
        style={{ paddingLeft: 8 + depth * 12 }}
        onClick={() => onOpen(query.id)}
        onContextMenu={(e) => openMenu(e, queryMenu(query))}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onOpen(query.id);
          }
          // F2 is the platform rename key, and it is discoverable now
          // that the context menu prints it next to Rename.
          if (e.key === "F2") {
            e.preventDefault();
            setRenaming(query.id);
          }
        }}
      >
        {/* Aligns queries with the collection rows above them. */}
        <span className="twisty" />
        <span className="tree-name">{query.name}</span>
        {dirty && <span className="dirty-dot" title="unsaved changes">•</span>}
        <button
          className="row-action"
          title="More…"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            // Same menu the right-click opens, from the row's own
            // button — so the actions are reachable by pointer without
            // knowing to right-click, and by keyboard via the button.
            openMenu(e, queryMenu(query));
          }}
        >
          ⋯
        </button>
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
            role="treeitem"
            aria-expanded={!isCollapsed}
            tabIndex={0}
            style={{ paddingLeft: 8 + depth * 12 }}
            onClick={() => toggle(node.collection.id)}
            onContextMenu={(e) => openMenu(e, collectionMenu(node.collection.id))}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                toggle(node.collection.id);
              }
              if (e.key === "F2") {
                e.preventDefault();
                setRenaming(node.collection.id);
              }
            }}
          >
            <span className="twisty">{isCollapsed ? "▸" : "▾"}</span>
            <span className="tree-name">{node.collection.name}</span>
            <button
              className="row-action"
              title="New query in this folder"
              onClick={(e) => {
                e.stopPropagation();
                onNewQueryInCollection(node.collection.id);
              }}
            >
              +
            </button>
            <button
              className="row-action"
              title="More…"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                openMenu(e, collectionMenu(node.collection.id));
              }}
            >
              ⋯
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
    <div className="query-tree" role="tree">
      {roots.map((node) => renderNode(node, 0))}
      {looseQueries.map((query) => renderQuery(query, 0))}
      {creatingAtRoot && (
        <RenameInput
          initial=""
          depth={0}
          placeholder={creating.kind === "collection" ? "Folder name" : "Query name"}
          onCommit={onCommitCreate}
          onCancel={onCancelCreate}
        />
      )}
      <ContextMenu menu={menu} onClose={closeMenu} />
    </div>
  );
}
