import { useCallback, useEffect, useState } from "react";
import { ConnectionForm } from "./components/ConnectionForm";
import { ResultGrid } from "./components/ResultGrid";
import { Sidebar } from "./components/Sidebar";
import { SqlEditor } from "./components/SqlEditor";
import { StatusBar } from "./components/StatusBar";
import { TabBar } from "./components/TabBar";
import { useLibrary } from "./hooks/useLibrary";
import { asAppError, execute } from "./lib/ipc";
import { effectiveSql } from "./lib/tree";
import type { AppErrorPayload, ConnectionInfo, LibraryTree, QueryResult } from "./types";
import "./App.css";

/**
 * Whether deleting this collection would also delete queries — directly
 * or via a nested collection. Deletion is hard and cascading, so this
 * gates whether we ask for confirmation before firing it.
 */
function collectionHasQueries(library: LibraryTree, collectionId: string): boolean {
  const scope = new Set<string>();
  const stack = [collectionId];
  while (stack.length > 0) {
    const current = stack.pop()!;
    scope.add(current);
    for (const c of library.collections) {
      if (c.parent_id === current) stack.push(c.id);
    }
  }
  return library.queries.some((q) => q.collection_id !== null && scope.has(q.collection_id));
}

export default function App() {
  const [connection, setConnection] = useState<ConnectionInfo | null>(null);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<AppErrorPayload | null>(null);
  const [busy, setBusy] = useState(false);

  const { library, tabs, activeTab, loaded, queryById, autosave, actions } =
    useLibrary();

  // The editor's text is local while typing; autosave persists it.
  const [text, setText] = useState("");

  // When the active tab changes, load its text into the editor.
  useEffect(() => {
    if (!activeTab) {
      setText("");
      return;
    }
    const query = queryById(activeTab.query_id);
    setText(query ? effectiveSql(query) : (activeTab.scratch_sql ?? ""));
    // Only re-run when the tab identity changes, not on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab?.id]);

  // Open one empty tab on first launch so there is somewhere to type.
  useEffect(() => {
    if (loaded && tabs.length === 0) void actions.newTab();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, tabs.length]);

  const onChange = useCallback(
    (value: string) => {
      setText(value);
      if (activeTab) autosave(activeTab, value);
    },
    [activeTab, autosave],
  );

  const run = useCallback(async () => {
    if (!connection) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await execute(connection.id, text));
    } catch (e) {
      setError(asAppError(e));
      setResult(null);
    } finally {
      setBusy(false);
    }
  }, [connection, text]);

  const save = useCallback(async () => {
    if (!activeTab) return;
    const query = queryById(activeTab.query_id);
    if (query) {
      await actions.save(activeTab, text, query.name);
      return;
    }
    const name = window.prompt("Name this query");
    if (name?.trim()) await actions.save(activeTab, text, name.trim());
  }, [activeTab, queryById, actions, text]);

  // Cmd+S saves the active tab.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        void save();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save]);

  if (!connection) {
    return (
      <main className="app centered">
        <h1>Quarry</h1>
        <ConnectionForm onConnected={setConnection} />
      </main>
    );
  }

  return (
    <main className="app with-sidebar">
      <Sidebar
        library={library}
        activeQueryId={activeTab?.query_id ?? null}
        onOpen={(id) => void actions.openQuery(id)}
        onNewCollection={() => {
          const name = window.prompt("Collection name");
          if (name?.trim()) void actions.createCollection(name.trim(), null);
        }}
        onRenameQuery={(id, name) => void actions.renameQuery(id, name)}
        onDeleteQuery={(id) => void actions.deleteQuery(id)}
        onRenameCollection={(id, name) => void actions.renameCollection(id, name)}
        onDeleteCollection={(id) => {
          const message = collectionHasQueries(library, id)
            ? "Delete this collection and everything in it? This cannot be undone."
            : "Delete this collection? This cannot be undone.";
          if (window.confirm(message)) void actions.deleteCollection(id);
        }}
      />

      <div className="main-pane">
        <header className="top-bar">
          <strong>
            {connection.user}@{connection.host}:{connection.port}/
            {connection.dbname}
          </strong>
          <button className="save-button" onClick={() => void save()}>
            Save ⌘S
          </button>
        </header>

        <TabBar
          tabs={tabs}
          queryById={queryById}
          onActivate={(id) => void actions.activateTab(id)}
          onClose={(id) => void actions.closeTab(id)}
          onNew={() => void actions.newTab()}
        />

        <SqlEditor value={text} onChange={onChange} onRun={run} busy={busy} />
        {result && <ResultGrid result={result} />}
        <StatusBar result={result} error={error} />
      </div>
    </main>
  );
}
