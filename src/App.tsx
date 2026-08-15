import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { ConnectionEditor } from "./components/ConnectionEditor";
import { ConnectionPicker } from "./components/ConnectionPicker";
import { PasswordRetry } from "./components/PasswordRetry";
import type { Creating } from "./components/QueryTree";
import { ResultGrid } from "./components/ResultGrid";
import { Sidebar } from "./components/Sidebar";
import { SidebarResizer } from "./components/SidebarResizer";
import { SqlEditor } from "./components/SqlEditor";
import { StatusBar } from "./components/StatusBar";
import { TabBar } from "./components/TabBar";
import { TableView } from "./components/TableView";
import { useConnections } from "./hooks/useConnections";
import { useLibrary } from "./hooks/useLibrary";
import { useSchema } from "./hooks/useSchema";
import { asAppError, execute } from "./lib/ipc";
import { DEFAULT_SIDEBAR_WIDTH } from "./lib/layout";
import type { SortState } from "./lib/gridSort";
import { buildCompletionSchema, previewSql } from "./lib/schema";
import { tableDetail } from "./lib/tableDetail";
import { effectiveSql } from "./lib/tree";
import type { AppErrorPayload, Connection, ConnectionInput, LibraryTree, QueryResult } from "./types";
import type { TableMode } from "./types";
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

  // Deliberately not persisted: one integer of UI state, restored by a
  // single drag.
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);

  const { library, tabs, activeTab, loaded, queryById, autosave, actions } =
    useLibrary();

  const {
    schema: dbSchema,
    loading: schemaLoading,
    error: schemaError,
    refresh: refreshDbSchema,
  } = useSchema(connection?.id ?? null);

  // Rebuilt only when the schema changes, not on every keystroke —
  // an unstable object here would tear down CodeMirror's state.
  const completionSchema = useMemo(
    () => buildCompletionSchema(dbSchema),
    [dbSchema],
  );

  // A tab either targets a table or holds a query buffer, never both.
  const tableTarget =
    activeTab?.target_schema && activeTab.target_table
      ? { schema: activeTab.target_schema, table: activeTab.target_table }
      : null;

  const detail = useMemo(
    () =>
      tableTarget ? tableDetail(dbSchema, tableTarget.schema, tableTarget.table) : null,
    [dbSchema, tableTarget?.schema, tableTarget?.table],
  );

  // Sort lives here rather than in the grid because a table Data tab
  // sorts by re-running the query, which only App can do.
  const [sort, setSort] = useState<SortState | null>(null);
  // The statement behind the current result, for truncation detection
  // and for re-running a Data tab in a new order.
  const [ranSql, setRanSql] = useState("");

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
    // A table tab has no editor buffer; leave the editor's text alone.
    if (activeTab.target_table) return;
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
      if (!activeTab) return;
      // The first edit promotes a preview to an ordinary tab, so the next
      // double-click cannot overwrite work in progress.
      if (activeTab.is_preview) void actions.promoteTab(activeTab.id);
      autosave(activeTab, value);
    },
    [activeTab, autosave, actions],
  );

  const runSql = useCallback(
    async (sql: string) => {
      if (!connection) return;
      setBusy(true);
      setError(null);
      try {
        setResult(await execute(sql));
        setRanSql(sql);
      } catch (e) {
        setError(asAppError(e));
        // The previous result deliberately stays on screen. A sort on a
        // Data tab is a re-run, so a failed sort would otherwise throw
        // away the rows you already had — worse than the failure.
      } finally {
        setBusy(false);
      }
    },
    [connection],
  );

  const run = useCallback(() => {
    setSort(null);
    void runSql(text);
  }, [runSql, text]);

  // Single-click in the tree: a disposable structure tab, reused by the
  // next click so navigating the tree does not open a tab per row.
  const openTableStructure = useCallback(
    async (schemaName: string, tableName: string) => {
      await actions.openTableTab(schemaName, tableName, "structure", false);
    },
    [actions],
  );

  // Double-click: data, pinned — an explicit "keep this one".
  const openTableData = useCallback(
    async (schemaName: string, tableName: string) => {
      setSort(null);
      await actions.openTableTab(schemaName, tableName, "data", true);
      await runSql(previewSql(schemaName, tableName));
    },
    [actions, runSql],
  );

  const changeTableMode = useCallback(
    async (next: TableMode) => {
      if (!activeTab || !tableTarget) return;
      setSort(null);
      await actions.setTabMode(activeTab.id, next);
      if (next === "data") await runSql(previewSql(tableTarget.schema, tableTarget.table));
    },
    [activeTab, tableTarget, actions, runSql],
  );

  // A Data tab re-runs with ORDER BY, because its rows are capped at
  // PREVIEW_LIMIT and sorting that page in memory would answer a
  // question nobody asked. A query tab sorts its fetched rows, since
  // re-running would either strip a LIMIT the user wrote or return the
  // very same rows.
  const changeSort = useCallback(
    async (next: SortState | null) => {
      setSort(next);

      if (!tableTarget || activeTab?.mode !== "data") return;

      const column = next === null ? undefined : result?.columns[next.column]?.name;
      await runSql(
        previewSql(
          tableTarget.schema,
          tableTarget.table,
          column && next ? { column, direction: next.direction } : undefined,
        ),
      );
    },
    [tableTarget, activeTab?.mode, result, runSql],
  );

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
        // 28P01 is invalid_password. A connect attempt made with no
        // password at all comes back as "password_required" instead
        // (see AppError::PasswordRequired) since it usually isn't a
        // wrong password so much as a missing one. Either way, offer
        // the password inline rather than making the user go and edit
        // the connection.
        // A "keychain" error is included deliberately. It means the
        // stored credential could not be READ — which happens routinely
        // in development, because `tauri dev` re-signs the binary on
        // every rebuild and macOS scopes Keychain items to the identity
        // that created them. The error text still names that cause, but
        // without the field the user has no way forward; typing the
        // password re-saves it under the current identity and works.
        setPasswordFor(
          err.kind === "password_required" ||
            err.kind === "keychain" ||
            err.code === "28P01"
            ? id
            : null,
        );
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
      <div className="sidebar-shell" style={{ width: sidebarWidth }}>
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
          schema={dbSchema}
          schemaLoading={schemaLoading}
          schemaError={schemaError}
          connected={connection !== null}
          onRefreshSchema={() => void refreshDbSchema()}
          onOpenTableStructure={(s, t) => void openTableStructure(s, t)}
          onPreviewTable={(s, t) => void openTableData(s, t)}
        />
      </div>
      <SidebarResizer onResize={setSidebarWidth} />

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

        {tableTarget ? (
          <TableView
            schemaName={tableTarget.schema}
            tableName={tableTarget.table}
            detail={detail}
            mode={activeTab?.mode ?? "structure"}
            onModeChange={(next) => void changeTableMode(next)}
            onRefreshSchema={() => void refreshDbSchema()}
          >
            {result && (
              <ResultGrid
                result={result}
                sql={ranSql}
                sort={sort}
                onSortChange={(next) => void changeSort(next)}
                serverSorted={tableTarget !== null && activeTab?.mode === "data"}
              />
            )}
          </TableView>
        ) : (
          <>
            <SqlEditor
              value={text}
              onChange={onChange}
              onRun={run}
              busy={busy}
              completionSchema={completionSchema}
            />
            {result && (
              <ResultGrid
                result={result}
                sql={ranSql}
                sort={sort}
                onSortChange={(next) => void changeSort(next)}
                serverSorted={tableTarget !== null && activeTab?.mode === "data"}
              />
            )}
          </>
        )}
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
