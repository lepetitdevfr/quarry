import { useCallback, useEffect, useMemo, useRef, useState } from "react";
// Aliased: this module already has a `save` callback for Cmd+S.
import { save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { ConnectionEditor } from "./components/ConnectionEditor";
import { ConnectionPicker } from "./components/ConnectionPicker";
import { EditBar } from "./components/EditBar";
import { GridToolbar } from "./components/GridToolbar";
import type { ExportFormat } from "./components/GridToolbar";
import { PasswordRetry } from "./components/PasswordRetry";
import type { Creating } from "./components/QueryTree";
import { ResultGrid } from "./components/ResultGrid";
import { Sidebar } from "./components/Sidebar";
import { SidebarResizer } from "./components/SidebarResizer";
import { SqlEditor } from "./components/SqlEditor";
import { StatusBar } from "./components/StatusBar";
import { TabBar } from "./components/TabBar";
import { TableView } from "./components/TableView";
import { UnlockDialog } from "./components/UnlockDialog";
import { useConnections } from "./hooks/useConnections";
import { useLibrary } from "./hooks/useLibrary";
import { useSchema } from "./hooks/useSchema";
import {
  applyRowEdits,
  asAppError,
  execute,
  guardStatus,
  previewEdits,
  relock,
  unlock,
  writeTextFile,
} from "./lib/ipc";
import {
  applyPatches,
  count as pendingCount,
  emptyPending,
  stage,
  toRowEdits,
} from "./lib/pendingEdits";
import type { Pending } from "./lib/pendingEdits";
import { formatCountdown } from "./lib/guard";
import { DEFAULT_SIDEBAR_WIDTH } from "./lib/layout";
import type { SortState } from "./lib/gridSort";
import { sortedIndices } from "./lib/gridSort";
import { toCsv, toJson, toSqlInsert } from "./lib/exportRows";
import { buildCompletionSchema, previewSql } from "./lib/schema";
import { tableDetail } from "./lib/tableDetail";
import { effectiveSql } from "./lib/tree";
import type {
  AppErrorPayload,
  Connection,
  ConnectionInput,
  EditStatement,
  GuardStatus,
  LibraryTree,
  QueryResult,
} from "./types";
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

  // Cell edits staged against `result`, and the statements the backend
  // would run for them while the SQL panel is open.
  const [pending, setPending] = useState<Pending>(emptyPending());
  const [editSql, setEditSql] = useState<EditStatement[] | null>(null);
  const [applying, setApplying] = useState(false);

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

  const [guard, setGuard] = useState<GuardStatus | null>(null);
  const [unlockOpen, setUnlockOpen] = useState(false);

  // Polled once a second while connected: the countdown has to tick, and
  // the server is the only authority on whether the unlock is still
  // live. A local timer alone would keep showing time remaining after an
  // expiry the server had already enforced.
  useEffect(() => {
    if (!connection) {
      setGuard(null);
      return;
    }
    let cancelled = false;
    async function poll() {
      try {
        const status = await guardStatus();
        if (!cancelled) setGuard(status);
      } catch {
        // A failed poll is not worth an error banner; the next one
        // will either succeed or the connection is gone anyway.
      }
    }
    void poll();
    const handle = window.setInterval(() => void poll(), 1000);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, [connection]);

  const locked =
    guard?.policy === "read_only" && guard.unlocked_seconds_remaining === null;
  const unlocked =
    guard?.policy === "read_only" && guard.unlocked_seconds_remaining !== null;

  // Editing is off entirely when the connection is locked or the result
  // is not one the backend decided is editable.
  const canEditRows = Boolean(result?.edit.editable) && !locked;

  function onStage(row: number, col: number, value: string | null) {
    if (!result) return;
    setPending((current) => stage(current, result, row, col, value));
    // The shown SQL is about a set of edits that just changed.
    setEditSql(null);
  }

  async function onViewSql() {
    if (!result) return;
    try {
      setEditSql(await previewEdits(result.edit, toRowEdits(pending, result)));
    } catch (e) {
      setError(asAppError(e));
    }
  }

  async function onConfirmEdits() {
    if (!result) return;
    setApplying(true);
    try {
      const applied = await applyRowEdits(
        result.edit,
        toRowEdits(pending, result),
      );
      // Patch with what the database returned, not with what was
      // typed: a trigger or a type coercion may have changed it.
      setResult(applyPatches(result, applied));
      setPending(emptyPending());
      setEditSql(null);
      setError(null);
    } catch (e) {
      // The whole batch rolled back, so the staged edits stay staged —
      // the user can fix the offending cell and confirm again.
      setError(asAppError(e));
    } finally {
      setApplying(false);
    }
  }

  const doUnlock = useCallback(async (typedName: string) => {
    try {
      await unlock(typedName);
      setUnlockOpen(false);
      setGuard(await guardStatus());
    } catch (e) {
      setError(asAppError(e));
    }
  }, []);

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
        // Staged edits belong to the rows they were staged against.
        setPending(emptyPending());
        setEditSql(null);
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

  // Single-click in the tree: the rows, which is what you usually want
  // from a table. The tab is disposable and reused by the next click, so
  // browsing the tree does not open a tab per row — but note each click
  // does run the preview query, unlike the structure view, which renders
  // from the cached schema.
  const openTableData = useCallback(
    async (schemaName: string, tableName: string) => {
      setSort(null);
      await actions.openTableTab(schemaName, tableName, "data", false);
      await runSql(previewSql(schemaName, tableName));
    },
    [actions, runSql],
  );

  // Double-click: structure, pinned — an explicit "keep this one".
  const openTableStructure = useCallback(
    async (schemaName: string, tableName: string) => {
      await actions.openTableTab(schemaName, tableName, "structure", true);
    },
    [actions],
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

  // Whether the rows already arrived in database order.
  const serverSorted = tableTarget !== null && activeTab?.mode === "data";

  const [exporting, setExporting] = useState(false);

  const exportResult = useCallback(
    async (format: ExportFormat) => {
      if (!result) return;

      const base = tableTarget?.table ?? activeTab?.title ?? "result";
      const extension = format === "sql" ? "sql" : format;

      const path = await saveFileDialog({
        defaultPath: `${base}.${extension}`,
        filters: [{ name: format.toUpperCase(), extensions: [extension] }],
      });

      // `save` returns null when the user cancels. That is not a
      // failure and must not be reported as one.
      if (path === null) return;

      // Display order, so a sorted grid exports sorted.
      const rows = sortedIndices(result.rows, serverSorted ? null : sort).map(
        (i) => result.rows[i],
      );

      let contents: string;
      if (format === "csv") contents = toCsv(result.columns, rows);
      else if (format === "json") contents = toJson(result.columns, rows);
      else if (tableTarget) {
        contents = toSqlInsert(
          tableTarget.schema,
          tableTarget.table,
          result.columns,
          rows,
        );
      } else return;

      setExporting(true);
      try {
        await writeTextFile(path, contents);
      } catch (e) {
        setError(asAppError(e));
      } finally {
        setExporting(false);
      }
    },
    [result, tableTarget, activeTab?.title, sort, serverSorted],
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
        setPending(emptyPending());
        setEditSql(null);
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
    <main className={`app with-sidebar${unlocked ? " unlocked" : ""}`}>
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
          onTableClick={(s, t) => void openTableData(s, t)}
          onTableDoubleClick={(s, t) => void openTableStructure(s, t)}
        />
      </div>
      <SidebarResizer onResize={setSidebarWidth} />

      <div className="main-pane">
        {unlocked && (
          <div className="unlock-banner">
            <span>
              Unlocked for writes ·{" "}
              {formatCountdown(guard?.unlocked_seconds_remaining ?? 0)}
            </span>
            <button
              onClick={() => {
                void relock().then(async () => setGuard(await guardStatus()));
              }}
            >
              Relock
            </button>
          </div>
        )}
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
              <>
                <GridToolbar
                  canExportSql={tableTarget !== null}
                  busy={exporting}
                  onExport={(f) => void exportResult(f)}
                />
                <ResultGrid
                  result={result}
                  sql={ranSql}
                  sort={sort}
                  onSortChange={(next) => void changeSort(next)}
                  serverSorted={serverSorted}
                  pending={canEditRows ? pending : null}
                  onStage={onStage}
                />
                {canEditRows && (
                  <EditBar
                    count={pendingCount(pending)}
                    statements={editSql}
                    busy={applying}
                    onViewSql={() => void onViewSql()}
                    onHideSql={() => setEditSql(null)}
                    onCancel={() => {
                      setPending(emptyPending());
                      setEditSql(null);
                    }}
                    onConfirm={() => void onConfirmEdits()}
                  />
                )}
              </>
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
              <>
                <GridToolbar
                  canExportSql={tableTarget !== null}
                  busy={exporting}
                  onExport={(f) => void exportResult(f)}
                />
                <ResultGrid
                  result={result}
                  sql={ranSql}
                  sort={sort}
                  onSortChange={(next) => void changeSort(next)}
                  serverSorted={serverSorted}
                  pending={canEditRows ? pending : null}
                  onStage={onStage}
                />
                {canEditRows && (
                  <EditBar
                    count={pendingCount(pending)}
                    statements={editSql}
                    busy={applying}
                    onViewSql={() => void onViewSql()}
                    onHideSql={() => setEditSql(null)}
                    onCancel={() => {
                      setPending(emptyPending());
                      setEditSql(null);
                    }}
                    onConfirm={() => void onConfirmEdits()}
                  />
                )}
              </>
            )}
          </>
        )}
        {error?.kind === "write_blocked" && locked && (
          <div className="guard-denial">
            <span>{error.message}</span>
            <button onClick={() => setUnlockOpen(true)}>Unlock…</button>
          </div>
        )}
        <StatusBar
          result={result}
          error={error}
          saved={showSaved}
          locked={locked}
        />
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

      {unlockOpen && connection && (
        <UnlockDialog
          connectionName={
            connections.find((c) => c.id === connection.id)?.name ?? ""
          }
          onConfirm={(name) => void doUnlock(name)}
          onCancel={() => setUnlockOpen(false)}
        />
      )}
    </main>
  );
}
