import { useCallback, useEffect, useRef, useState } from "react";
import * as ipc from "../lib/ipc";
import type { LibraryTree, Query, Tab, TableMode, TabPin } from "../types";

/** How long typing must pause before a draft is written. */
const AUTOSAVE_DELAY_MS = 400;

const EMPTY: LibraryTree = { collections: [], queries: [] };

/**
 * Owns library and tab state, plus debounced autosave.
 *
 * Every mutating IPC call returns the refreshed tree or tab list, so
 * state is replaced with what the backend reports rather than patched
 * locally — the two can never drift apart.
 */
export function useLibrary() {
  const [library, setLibrary] = useState<LibraryTree>(EMPTY);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [loaded, setLoaded] = useState(false);

  // Restore the previous session on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [tree, openTabs] = await Promise.all([ipc.libraryTree(), ipc.listTabs()]);
      if (cancelled) return;
      setLibrary(tree);
      setTabs(openTabs);
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const activeTab = tabs.find((t) => t.is_active) ?? null;

  const queryById = useCallback(
    (id: string | null): Query | null =>
      id === null ? null : (library.queries.find((q) => q.id === id) ?? null),
    [library.queries],
  );

  // ---- autosave ------------------------------------------------------

  // One pending timer *per tab*, keyed by tab id. A single shared timer
  // would let editing tab B cancel a still-pending save for tab A —
  // switching tabs mid-edit must never drop a draft.
  const timers = useRef<Map<string, ReturnType<typeof window.setTimeout>>>(new Map());

  const flush = useCallback((tab: Tab, sql: string) => {
    timers.current.delete(tab.id);
    void (async () => {
      if (tab.query_id) {
        await ipc.saveDraft(tab.query_id, sql);
        setLibrary((prev) => ({
          ...prev,
          queries: prev.queries.map((q) =>
            q.id === tab.query_id ? { ...q, draft_sql: sql } : q,
          ),
        }));
      } else {
        await ipc.saveScratch(tab.id, sql);
        setTabs((prev) =>
          prev.map((t) => (t.id === tab.id ? { ...t, scratch_sql: sql } : t)),
        );
      }
    })();
  }, []);

  /**
   * Debounced write of the editor text. Saved queries get a draft;
   * untitled tabs get scratch text. Both survive a restart.
   */
  const autosave = useCallback(
    (tab: Tab, sql: string) => {
      const existing = timers.current.get(tab.id);
      if (existing !== undefined) window.clearTimeout(existing);

      const handle = window.setTimeout(() => flush(tab, sql), AUTOSAVE_DELAY_MS);
      timers.current.set(tab.id, handle);
    },
    [flush],
  );

  // Clear any pending timers if the component unmounts mid-debounce.
  // (App quit / navigation away — nothing left to flush the writes to.)
  useEffect(() => {
    return () => {
      for (const handle of timers.current.values()) window.clearTimeout(handle);
      timers.current.clear();
    };
  }, []);

  // ---- actions -------------------------------------------------------

  const actions = {
    openQuery: async (queryId: string) => setTabs(await ipc.openTab(queryId)),
    newTab: async () => setTabs(await ipc.openTab(null)),
    activateTab: async (id: string) => setTabs(await ipc.activateTab(id)),
    closeTab: async (id: string) => setTabs(await ipc.closeTab(id)),
    openPreview: async (title: string, sql: string) =>
      setTabs(await ipc.openPreviewTab(title, sql)),
    promoteTab: async (id: string) => setTabs(await ipc.promoteTab(id)),
    openTableTab: async (
      schema: string,
      table: string,
      mode: TableMode,
      pin: TabPin,
    ) => setTabs(await ipc.openTableTab(schema, table, mode, pin)),
    setTabMode: async (id: string, mode: TableMode) =>
      setTabs(await ipc.setTabMode(id, mode)),

    createCollection: async (name: string, parentId: string | null) =>
      setLibrary(await ipc.createCollection(name, parentId)),
    renameCollection: async (id: string, name: string) =>
      setLibrary(await ipc.renameCollection(id, name)),
    deleteCollection: async (id: string) => {
      setLibrary(await ipc.deleteCollection(id));
      // Deleting a collection cascades to its queries, which closes
      // their tabs in the database — refetch so the UI agrees.
      setTabs(await ipc.listTabs());
    },

    /** Create a query and immediately open it in an active tab, so the
     * user lands in the editor ready to type. */
    createQuery: async (name: string, collectionId: string | null) => {
      const created = await ipc.createQuery(name, "", collectionId);
      setLibrary(await ipc.libraryTree());
      setTabs(await ipc.openTab(created.id));
    },

    renameQuery: async (id: string, name: string) =>
      setLibrary(await ipc.renameQuery(id, name)),
    deleteQuery: async (id: string) => {
      setLibrary(await ipc.deleteQuery(id));
      setTabs(await ipc.listTabs());
    },
    moveQuery: async (id: string, collectionId: string | null) =>
      setLibrary(await ipc.moveQuery(id, collectionId)),

    /** Explicit save. Turns an untitled tab into a real saved query. */
    save: async (tab: Tab, sql: string, nameIfNew: string) => {
      if (tab.query_id) {
        await ipc.saveQuery(tab.query_id, sql);
        setLibrary(await ipc.libraryTree());
      } else {
        const created = await ipc.createQuery(nameIfNew, sql, null);
        await ipc.saveQuery(created.id, sql);
        setLibrary(await ipc.libraryTree());
        // Repoint the tab at the new query: close the scratch tab and
        // open one for the saved query.
        await ipc.closeTab(tab.id);
        setTabs(await ipc.openTab(created.id));
      }
    },
  };

  return { library, tabs, activeTab, loaded, queryById, autosave, actions };
}
