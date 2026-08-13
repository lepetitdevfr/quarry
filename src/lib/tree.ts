import type { LibraryTree, Query, TreeNode } from "../types";

export interface BuiltTree {
  roots: TreeNode[];
  /** Queries not filed in any collection. */
  looseQueries: Query[];
}

/**
 * Turn the flat lists the backend sends into a renderable tree.
 *
 * A collection whose `parent_id` points at something missing is treated
 * as a root rather than dropped — losing a folder from the sidebar
 * because of one bad reference would look like data loss to the user.
 */
export function buildTree(library: LibraryTree): BuiltTree {
  const byPosition = <T extends { position: number }>(a: T, b: T) =>
    a.position - b.position;

  const nodes = new Map<string, TreeNode>();
  for (const collection of library.collections) {
    nodes.set(collection.id, { collection, children: [], queries: [] });
  }

  const roots: TreeNode[] = [];
  for (const collection of [...library.collections].sort(byPosition)) {
    const node = nodes.get(collection.id)!;
    const parent =
      collection.parent_id === null ? undefined : nodes.get(collection.parent_id);

    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  const looseQueries: Query[] = [];
  for (const query of [...library.queries].sort(byPosition)) {
    const parent =
      query.collection_id === null ? undefined : nodes.get(query.collection_id);

    if (parent) {
      parent.queries.push(query);
    } else {
      looseQueries.push(query);
    }
  }

  return { roots, looseQueries };
}

/** The text the editor should show: draft if present, else saved. */
export function effectiveSql(query: Query): string {
  return query.draft_sql ?? query.sql;
}

/** Whether the draft differs from the saved text. */
export function isDirty(query: Query): boolean {
  return query.draft_sql !== null && query.draft_sql !== query.sql;
}
