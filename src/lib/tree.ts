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

/** Somewhere a query can be moved to. `id: null` is the top level. */
export interface MoveTarget {
  id: string | null;
  /** Full path, so two folders sharing a name stay distinguishable. */
  label: string;
}

/**
 * Where this query can be moved.
 *
 * Its current home is left out: a menu entry that does nothing reads as
 * a bug. The top level appears only when the query is filed somewhere,
 * for the same reason.
 *
 * Labels carry the whole path — two collections can share a name, and a
 * menu of identical entries is worse than no menu. A collection whose
 * parent is missing keeps its own name rather than being dropped, the
 * same call `buildTree` makes: a bad reference must not make a folder
 * unreachable.
 */
export function moveTargets(library: LibraryTree, query: Query): MoveTarget[] {
  const byId = new Map(library.collections.map((c) => [c.id, c]));

  const pathOf = (id: string): string => {
    const segments: string[] = [];
    const seen = new Set<string>();
    let current: string | undefined = id;

    while (current !== undefined && !seen.has(current)) {
      seen.add(current);
      const collection = byId.get(current);
      if (!collection) break;
      segments.unshift(collection.name);
      current = collection.parent_id ?? undefined;
    }

    return segments.join(" / ");
  };

  const targets: MoveTarget[] = library.collections
    .filter((c) => c.id !== query.collection_id)
    .map((c) => ({ id: c.id as string | null, label: pathOf(c.id) }))
    .sort((a, b) => a.label.localeCompare(b.label));

  if (query.collection_id !== null) {
    targets.unshift({ id: null, label: "Top level" });
  }

  return targets;
}
