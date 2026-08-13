import { describe, expect, it } from "vitest";
import { buildTree, effectiveSql, isDirty } from "./tree";
import type { Collection, LibraryTree, Query } from "../types";

function collection(id: string, parent: string | null, pos = 100): Collection {
  return {
    id,
    parent_id: parent,
    name: id,
    position: pos,
    created_at: "",
  };
}

function query(id: string, collectionId: string | null, pos = 100): Query {
  return {
    id,
    collection_id: collectionId,
    name: id,
    sql: "select 1",
    draft_sql: null,
    position: pos,
    created_at: "",
    updated_at: "",
  };
}

describe("buildTree", () => {
  it("returns an empty tree for an empty library", () => {
    const tree: LibraryTree = { collections: [], queries: [] };
    expect(buildTree(tree)).toEqual({ roots: [], looseQueries: [] });
  });

  it("nests child collections under their parent", () => {
    const tree: LibraryTree = {
      collections: [collection("parent", null), collection("child", "parent")],
      queries: [],
    };

    const { roots } = buildTree(tree);
    expect(roots).toHaveLength(1);
    expect(roots[0].collection.id).toBe("parent");
    expect(roots[0].children[0].collection.id).toBe("child");
  });

  it("places queries inside their collection", () => {
    const tree: LibraryTree = {
      collections: [collection("c", null)],
      queries: [query("q", "c")],
    };

    const { roots } = buildTree(tree);
    expect(roots[0].queries.map((q) => q.id)).toEqual(["q"]);
  });

  it("surfaces queries with no collection at the top level", () => {
    const tree: LibraryTree = {
      collections: [],
      queries: [query("loose", null)],
    };

    const { looseQueries } = buildTree(tree);
    expect(looseQueries.map((q) => q.id)).toEqual(["loose"]);
  });

  it("sorts siblings by position", () => {
    const tree: LibraryTree = {
      collections: [collection("b", null, 200), collection("a", null, 100)],
      queries: [query("z", null, 200), query("y", null, 100)],
    };

    const { roots, looseQueries } = buildTree(tree);
    expect(roots.map((r) => r.collection.id)).toEqual(["a", "b"]);
    expect(looseQueries.map((q) => q.id)).toEqual(["y", "z"]);
  });

  it("drops a collection whose parent is missing rather than losing it silently", () => {
    // A dangling parent_id should not make the whole tree disappear.
    const tree: LibraryTree = {
      collections: [collection("orphan", "gone")],
      queries: [],
    };

    const { roots } = buildTree(tree);
    expect(roots.map((r) => r.collection.id)).toEqual(["orphan"]);
  });
});

describe("effectiveSql", () => {
  it("prefers the draft over the saved text", () => {
    expect(effectiveSql({ ...query("q", null), draft_sql: "draft" })).toBe("draft");
  });

  it("falls back to the saved text when there is no draft", () => {
    expect(effectiveSql(query("q", null))).toBe("select 1");
  });

  it("treats an empty draft as real text, not as absent", () => {
    // Clearing the editor is a legitimate edit; it must not resurrect
    // the saved SQL.
    expect(effectiveSql({ ...query("q", null), draft_sql: "" })).toBe("");
  });
});

describe("isDirty", () => {
  it("is false with no draft", () => {
    expect(isDirty(query("q", null))).toBe(false);
  });

  it("is false when the draft matches the saved text", () => {
    expect(isDirty({ ...query("q", null), draft_sql: "select 1" })).toBe(false);
  });

  it("is true when the draft differs", () => {
    expect(isDirty({ ...query("q", null), draft_sql: "select 2" })).toBe(true);
  });
});
