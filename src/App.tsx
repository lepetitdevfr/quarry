import { useCallback, useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { ConnectionEditor } from "./components/ConnectionEditor";
import { ConnectionPicker } from "./components/ConnectionPicker";
import { PasswordRetry } from "./components/PasswordRetry";
import type { Creating } from "./components/QueryTree";
import { ResultGrid } from "./components/ResultGrid";
import { Sidebar } from "./components/Sidebar";
import { SqlEditor } from "./components/SqlEditor";
import { StatusBar } from "./components/StatusBar";
import { TabBar } from "./components/TabBar";
import { useConnections } from "./hooks/useConnections";
import { useLibrary } from "./hooks/useLibrary";
import { asAppError, execute } from "./lib/ipc";
import { effectiveSql } from "./lib/tree";
import type { AppErrorPayload, Connection, ConnectionInput, LibraryTree, QueryResult } from "./types";
import "./App.css";

/** How long the "Saved" indicator stays visible after a save. */
const SAVED_FLASH_MS = 2000;

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

interface ConfirmRequest {
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
}

export default function App() {
  const {
    connections,
    active: connection,
    connecting,
    loaded: connectionsLoaded,
    actions: connActions,
  } = useConnections();

  const [pickerOpen, setPickerOpen] = useState(false);
  const [editing, setEditing] = useState<Connection | "new" | null>(null);
  const [connectError, setConnectError] = useState<AppErrorPayload | null>(null);
  // Set when a connect failed for a credential reason, so the user can
  // supply a password inline instead of having to edit the connection.
  const [passwordFor, setPasswordFor] = useState<string | null>(null);

  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<AppErrorPayload | null>(null);
  const [busy, setBusy] = useState(false);

  const { library, tabs, activeTab, loaded, queryById, autosave, actions } =
    useLibrary();

  // The editor's text is local while typing; autosave persists it.
  const [text, setText] = useState("");

  // In-app replacements for window.prompt/confirm, which a Tauri
  // WKWebView does not implement.
  const [creating, setCreating] = useState<Creating | null>(null);
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null);
  // Id of the untitled tab currently being named as part of a save.
  const [namingTabId, setNamingTabId] = useState<string | null>(null);

  // Brief "Saved" confirmation in the status bar after a successful save.
  const [showSaved, setShowSaved] = useState(false);
  const savedTimer = useRef<number | null>(null);

  const flashSaved = useCallback(() => {
    setShowSaved(true);
    if (savedTimer.current !== null) window.clearTimeout(savedTimer.current);
    savedTimer.current = window.setTimeout(() => {
      setShowSaved(false);
      savedTimer.current = null;
    }, SAVED_FLASH_MS);
  }, []);

  useEffect(() => {
    return () => {
      if (savedTimer.current !== null) window.clearTimeout(savedTimer.current);
    };
  }, []);

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
      setResult(await execute(text));
    } catch (e) {
      setError(asAppError(e));
      setResult(null);
    } finally {
      setBusy(false);
    }
  }, [connection, text]);

  // Cmd+S saves the active tab. If it is untitled, this opens the
  // inline naming field in the tab bar instead of saving immediately —
  // commitNameAndSave (below) finishes the job once a name is entered.
  const save = useCallback(async () => {
    if (!activeTab) return;
    const query = queryById(activeTab.query_id);
    if (query) {
      await actions.save(activeTab, text, query.name);
      flashSaved();
      return;
    }
    setNamingTabId(activeTab.id);
  }, [activeTab, queryById, actions, text, flashSaved]);

  const commitNameAndSave = useCallback(
    async (name: string) => {
      if (!activeTab) return;
      await actions.save(activeTab, text, name);
      setNamingTabId(null);
      flashSaved();
    },
    [activeTab, actions, text, flashSaved],
  );

  // Cmd+S saves the active tab. No default keymap binding in CodeMirror
  // claims Mod-s, so it never stops the event from bubbling up to this
  // window-level listener — the handler works whether focus is in the
  // editor or anywhere else in the app.
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

  const commitCreate = useCallback(
    (name: string) => {
      if (!creating) return;
      if (creating.kind === "collection") {
        void actions.createCollection(name, creating.parentId);
      } else {
        void actions.createQuery(name, creating.parentId);
      }
      setCreating(null);
    },
    [creating, actions],
  );

  const requestDeleteQuery = useCallback(
    (id: string) => {
      setConfirmRequest({
        message: "Delete this query? This cannot be undone.",
        confirmLabel: "Delete",
        onConfirm: () => {
          void actions.deleteQuery(id);
          setConfirmRequest(null);
        },
      });
    },
    [actions],
  );

  const requestDeleteCollection = useCallback(
    (id: string) => {
      const message = collectionHasQueries(library, id)
        ? "Delete this collection and everything in it? This cannot be undone."
        : "Delete this collection? This cannot be undone.";
      setConfirmRequest({
        message,
        confirmLabel: "Delete",
        onConfirm: () => {
          void actions.deleteCollection(id);
          setConfirmRequest(null);
        },
      });
    },
    [library, actions],
  );

  const switchTo = useCallback(
    async (id: string, password?: string) => {
      setConnectError(null);
      try {
        await connActions.connect(id, password);
        setResult(null);
        setError(null);
        setPickerOpen(false);
        setPasswordFor(null);
      } catch (e) {
        // Stay disconnected and say why: believing you switched when
        // you did not is the dangerous state.
        const err = asAppError(e);
        setConnectError(err);
        // 28P01 is invalid_password. A missing Keychain entry produces
        // the same failure, so offer the password inline rather than
        // making the user go and edit the connection.
        setPasswordFor(err.code === "28P01" ? id : null);
      }
    },
    [connActions],
  );

  const saveConnection = useCallback(
    async (input: ConnectionInput) => {
      if (editing && editing !== "new") await connActions.update(editing.id, input);
      else await connActions.create(input);
      setEditing(null);
    },
    [editing, connActions],
  );

  // Close the header dropdown when clicking anywhere outside it.
  const connectionMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!pickerOpen) return;
    function onPointerDown(e: MouseEvent) {
      if (
        connectionMenuRef.current &&
        !connectionMenuRef.current.contains(e.target as Node)
      ) {
        setPickerOpen(false);
      }
    }
    window.addEventListener("mousedown", onPointerDown);
    return () => window.removeEventListener("mousedown", onPointerDown);
  }, [pickerOpen]);

  if (!connection) {
    return (
      <main className="app centered">
        <h1>Quarry</h1>
        {editing || (connectionsLoaded && connections.length === 0) ? (
          <ConnectionEditor
            existing={editing && editing !== "new" ? editing : undefined}
            onSave={(input) => void saveConnection(input)}
            onCancel={() => setEditing(null)}
          />
        ) : (
          <>
            <ConnectionPicker
              standalone
              connections={connections}
              activeId={null}
              connecting={connecting}
              onPick={(id) => void switchTo(id)}
              onNew={() => setEditing("new")}
              onEdit={(id) =>
                setEditing(connections.find((c) => c.id === id) ?? "new")
              }
              onDelete={(id) =>
                setConfirmRequest({
                  message: "Delete this connection and its saved password?",
                  confirmLabel: "Delete",
                  onConfirm: () => {
                    void connActions.remove(id);
                    setConfirmRequest(null);
                  },
                })
              }
            />
            {connectError && (
              <p className="error">
                {connectError.code && (
                  <span className="sqlstate">{connectError.code}</span>
                )}
                {connectError.message}
              </p>
            )}
            {passwordFor && (
              <PasswordRetry
                onSubmit={(pw) => void switchTo(passwordFor, pw)}
                onCancel={() => setPasswordFor(null)}
              />
            )}
          </>
        )}
        {confirmRequest && (
          <ConfirmDialog
            message={confirmRequest.message}
            confirmLabel={confirmRequest.confirmLabel}
            onConfirm={confirmRequest.onConfirm}
            onCancel={() => setConfirmRequest(null)}
          />
        )}
      </main>
    );
  }

  return (
    <main className="app with-sidebar">
      <Sidebar
        library={library}
        activeQueryId={activeTab?.query_id ?? null}
        onOpen={(id) => void actions.openQuery(id)}
        onNewQuery={() => setCreating({ kind: "query", parentId: null })}
        onNewCollection={() => setCreating({ kind: "collection", parentId: null })}
        onNewQueryInCollection={(collectionId) =>
          setCreating({ kind: "query", parentId: collectionId })
        }
        onRenameQuery={(id, name) => void actions.renameQuery(id, name)}
        onDeleteQuery={requestDeleteQuery}
        onRenameCollection={(id, name) => void actions.renameCollection(id, name)}
        onDeleteCollection={requestDeleteCollection}
        creating={creating}
        onCommitCreate={commitCreate}
        onCancelCreate={() => setCreating(null)}
      />

      <div className="main-pane">
        <header className="top-bar">
          <span
            className="tag-stripe"
            style={{
              background:
                connections.find((c) => c.id === connection.id)?.colour ?? "transparent",
            }}
          />
          <div className="connection-menu" ref={connectionMenuRef}>
            <button
              className="connection-trigger"
              onClick={() => setPickerOpen((open) => !open)}
            >
              <span
                className="dot"
                style={{
                  background:
                    connections.find((c) => c.id === connection.id)?.colour ?? "#888",
                }}
              />
              {connections.find((c) => c.id === connection.id)?.name ?? connection.dbname}
              <span className="caret">▾</span>
            </button>
            <span className="connection-target">
              {connection.user}@{connection.host}:{connection.port}/{connection.dbname}
            </span>

            {pickerOpen && (
              <ConnectionPicker
                connections={connections}
                activeId={connection.id}
                connecting={connecting}
                onPick={(id) => void switchTo(id)}
                onNew={() => {
                  setPickerOpen(false);
                  setEditing("new");
                }}
                onEdit={(id) => {
                  setPickerOpen(false);
                  setEditing(connections.find((c) => c.id === id) ?? "new");
                }}
                onDelete={(id) =>
                  setConfirmRequest({
                    message: "Delete this connection and its saved password?",
                    confirmLabel: "Delete",
                    onConfirm: () => {
                      void connActions.remove(id);
                      setConfirmRequest(null);
                    },
                  })
                }
              />
            )}
          </div>
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
          namingTabId={namingTabId}
          onCommitName={(name) => void commitNameAndSave(name)}
          onCancelName={() => setNamingTabId(null)}
        />

        <SqlEditor value={text} onChange={onChange} onRun={run} busy={busy} />
        {result && <ResultGrid result={result} />}
        <StatusBar result={result} error={error} saved={showSaved} />
      </div>

      {confirmRequest && (
        <ConfirmDialog
          message={confirmRequest.message}
          confirmLabel={confirmRequest.confirmLabel}
          onConfirm={confirmRequest.onConfirm}
          onCancel={() => setConfirmRequest(null)}
        />
      )}

      {editing && (
        <div className="modal-backdrop">
          <ConnectionEditor
            existing={editing !== "new" ? editing : undefined}
            onSave={(input) => void saveConnection(input)}
            onCancel={() => setEditing(null)}
          />
        </div>
      )}
    </main>
  );
}
