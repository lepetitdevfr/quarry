import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import iconUrl from "./assets/icon.png";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
// Aliased: this module already has a `save` callback for Cmd+S.
import { save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { ConnectionEditor } from "./components/ConnectionEditor";
import { ConnectionPicker } from "./components/ConnectionPicker";
import { EditBar } from "./components/EditBar";
import { ErrorPanel } from "./components/ErrorPanel";
import { PaneResizer } from "./components/PaneResizer";
import { GridToolbar } from "./components/GridToolbar";
import type { ExportFormat } from "./components/GridToolbar";
import { PasswordRetry } from "./components/PasswordRetry";
import type { Creating } from "./components/QueryTree";
import { ResultGrid } from "./components/ResultGrid";
import { Sidebar } from "./components/Sidebar";
import { SidebarResizer } from "./components/SidebarResizer";
import { SqlEditor } from "./components/SqlEditor";
import type { EditorHandle } from "./components/SqlEditor";
import { StatusBar } from "./components/StatusBar";
import { TabBar } from "./components/TabBar";
import { TableView } from "./components/TableView";
import { UnlockDialog } from "./components/UnlockDialog";
import { UpdateBanner } from "./components/UpdateBanner";
import { useConnections } from "./hooks/useConnections";
import { useLibrary } from "./hooks/useLibrary";
import { useSchema } from "./hooks/useSchema";
import {
  applyRowEdits,
  asAppError,
  execute,
  formatSql,
  forgetRecent as forgetRecentIpc,
  listRecent,
  guardStatus,
  previewEdits,
  relock,
  unlock,
  writeTextFile,
} from "./lib/ipc";
import {
  addInsert,
  applyPatches,
  emptyDeletes,
  emptyInserts,
  emptyPending,
  isDeleted,
  removeInsert,
  setInsertCell,
  stage,
  toRowDeletes,
  toRowEdits,
  toRowInserts,
  toggleDelete,
  totalPending,
} from "./lib/pendingEdits";
import { formatCountdown } from "./lib/guard";
import { shouldNotify } from "./lib/updates";
import {
  DEFAULT_EDITOR_HEIGHT,
  DEFAULT_SIDEBAR_WIDTH,
  clampEditorHeight,
} from "./lib/layout";
import { isTruncated } from "./lib/gridSort";
import {
  pruneResults,
  resultFor,
  withResult,
} from "./lib/tabResults";
import type { TabResult, TabResults } from "./lib/tabResults";
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
  GuardStatus,
  LibraryTree,
  RecentItem,
} from "./types";
import type { TableMode } from "./types";
import "./App.css";

/** How long the "Saved" indicator stays visible after a save. */
const SAVED_FLASH_MS = 2000;

/** Where releases are published — the public repo, not this one. */
const RELEASES_API =
  "https://api.github.com/repos/lepetitdevfr/quarry-releases/releases/latest";
const RELEASES_PAGE = "https://lepetitdevfr.github.io/quarry-releases/";
/** localStorage keys for the update check's two pieces of state. */
const UPDATE_CHECK_KEY = "quarry.updateCheck";
const UPDATE_DISMISSED_KEY = "quarry.updateDismissed";

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
    connectingId,
    loaded: connectionsLoaded,
    actions: connActions,
  } = useConnections();

  const [pickerOpen, setPickerOpen] = useState(false);
  const [editing, setEditing] = useState<Connection | "new" | null>(null);
  const [connectError, setConnectError] = useState<AppErrorPayload | null>(null);
  // Set when a connect failed for a credential reason, so the user can
  // supply a password inline instead of having to edit the connection.
  const [passwordFor, setPasswordFor] = useState<string | null>(null);

  // Results belong to the tab that ran them. As ten pieces of app-level
  // state they belonged to nobody: a brand-new tab showed the previous
  // tab's rows, and closing a tab left its grid on screen under somebody
  // else's editor. See `lib/tabResults.ts`.
  const [tabResults, setTabResults] = useState<TabResults>({});
  // Everything run or closed, newest first. Held here rather than in
  // the sidebar because two things outside it — running a statement and
  // closing a tab — are what change it.
  const [recent, setRecent] = useState<RecentItem[]>([]);

  const refreshRecent = useCallback(() => {
    void listRecent().then(setRecent);
  }, []);

  // The tab with a statement in flight, so only that tab says "Running…"
  // — a spinner on a tab that is not running is the same lie in miniature.
  const [busyTabId, setBusyTabId] = useState<string | null>(null);
  // Seconds the in-flight statement has been running. A query that
  // takes a while used to look identical to one that had finished: the
  // Run button said "Running…" and nothing else moved.
  const [elapsed, setElapsed] = useState(0);
  // How many changes the last confirmed batch applied, shown briefly.
  // Applying used to be silent — the bar vanished and the grid patched.
  const [appliedCount, setAppliedCount] = useState<number | null>(null);

  useEffect(() => {
    if (busyTabId === null) {
      setElapsed(0);
      return;
    }
    const started = performance.now();
    const handle = window.setInterval(
      () => setElapsed((performance.now() - started) / 1000),
      100,
    );
    return () => window.clearInterval(handle);
  }, [busyTabId]);

  // The SQL behind a Data tab, shown in an editor above the grid. Held
  // here rather than in the tab record: it is a scratch edit of a
  // generated query, and persisting it would make a table tab reopen
  // showing something other than the table.
  const [tableSql, setTableSql] = useState("");
  // Once the user edits it the tab stops being a generated preview, which
  // is what stops a sort from regenerating the query and discarding the
  // edit.
  const [tableSqlEdited, setTableSqlEdited] = useState(false);
  const [applying, setApplying] = useState(false);

  // Deliberately not persisted: one integer of UI state, restored by a
  // single drag.
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  // The editor/results split, on the same terms. It was a hard-coded
  // 200px, which is about nine lines — shorter than most real queries
  // and impossible to trade against the grid.
  const [editorHeight, setEditorHeight] = useState(DEFAULT_EDITOR_HEIGHT);
  const paneRef = useRef<HTMLDivElement>(null);

  const resizeEditor = useCallback((clientY: number) => {
    const pane = paneRef.current;
    if (!pane) return;
    const { top, height } = pane.getBoundingClientRect();
    setEditorHeight(clampEditorHeight(clientY - top, height));
  }, []);

  const nudgeEditor = useCallback((delta: number) => {
    const pane = paneRef.current;
    if (!pane) return;
    const { height } = pane.getBoundingClientRect();
    setEditorHeight((current) => clampEditorHeight(current + delta, height));
  }, []);

  // Handed over by whichever SqlEditor is mounted: the error panel uses
  // it to put the caret on the character Postgres complained about, and
  // the effect below uses it to open the app ready to type.
  const editor = useRef<EditorHandle | null>(null);
  const onEditorReady = useCallback((handle: EditorHandle) => {
    editor.current = handle;
  }, []);

  const { library, tabs, activeTab, loaded, queryById, autosave, actions } =
    useLibrary();

  // ---- the active tab's results ---------------------------------------
  //
  // The result, the error, the sort, the staged edits and the grid's
  // selection all belong to one tab now. Everything below reads and
  // writes the active tab's own copy, and the setters keep the names and
  // the shape the single-result version had — including functional
  // updates — so every call site still says what it means; what changed
  // is which tab it lands on.
  //
  // Anything that has to survive a tab switch mid-flight names its tab
  // explicitly instead: see `runSql`.
  const activeTabId = activeTab?.id ?? null;
  const current = resultFor(tabResults, activeTabId);
  const {
    result,
    error,
    ranSql,
    ranGenerated,
    sort,
    pending,
    deletes,
    inserts,
    selectedRow,
    editSql,
  } = current;
  const busy = busyTabId !== null && busyTabId === activeTabId;

  const setters = useMemo(() => {
    function setter<K extends keyof TabResult>(key: K) {
      return (value: TabResult[K] | ((previous: TabResult[K]) => TabResult[K])) =>
        setTabResults((all) => {
          const previous = resultFor(all, activeTabId)[key];
          const next =
            typeof value === "function"
              ? (value as (previous: TabResult[K]) => TabResult[K])(previous)
              : value;
          return withResult(all, activeTabId, { [key]: next });
        });
    }
    return {
      setResult: setter("result"),
      setError: setter("error"),
      setSort: setter("sort"),
      setPending: setter("pending"),
      setDeletes: setter("deletes"),
      setInserts: setter("inserts"),
      setSelectedRow: setter("selectedRow"),
      setEditSql: setter("editSql"),
    };
  }, [activeTabId]);
  const {
    setResult,
    setError,
    setSort,
    setPending,
    setDeletes,
    setInserts,
    setSelectedRow,
    setEditSql,
  } = setters;

  // A closed tab takes its rows with it. Pruning here rather than in the
  // close handler covers every way a tab can disappear — ⌘W, the ×,
  // "close others" — with one rule.
  useEffect(() => {
    setTabResults((all) => pruneResults(all, tabs.map((t) => t.id)));
  }, [tabs]);

  // History changes when a tab closes, and a close can arrive from four
  // different places. Watching the tab list catches all of them without
  // any of them having to remember.
  useEffect(() => refreshRecent(), [refreshRecent, tabs]);

  // The launch screen is a list and a button; a working session is a
  // sidebar, an editor and a grid. Sizing the window to whichever is on
  // screen means the app opens as a small panel rather than a mostly
  // empty 1200px window, and grows when there is something to fill it.
  //
  // The minimum moves with it: a connected window squeezed to 460px wide
  // has no room for the sidebar, and a launch panel held to 900px is the
  // problem this is solving.
  const connected = connection !== null;
  // The connection form is seven rows tall — URL, name, host and port, user
  // and database, password, tag and SSL, buttons — so the panel that fits a
  // list of connections cannot hold it. Three sizes rather than two, because
  // sizing the launch screen for its tallest state would leave the common
  // one mostly empty.
  // Focus the editor once per session, when the workspace first
  // appears, so the app opens ready to type. Focusing on every mount
  // would snatch the caret back each time you moved between a table tab
  // and a query tab, which is the opposite of helpful.
  const focusedOnce = useRef(false);
  useEffect(() => {
    if (!connected || focusedOnce.current) return;
    focusedOnce.current = true;
    editor.current?.focus();
  }, [connected]);

  const editorOpen = !connected && editing !== null;
  useEffect(() => {
    const window = getCurrentWindow();
    const [w, h, minW, minH] = connected
      ? [1200, 800, 900, 560]
      : editorOpen
        ? [620, 780, 520, 640]
        : [560, 520, 460, 420];

    // Order matters: shrinking below the current minimum is refused, so
    // the minimum has to come down first, and going the other way the
    // size has to arrive before the larger minimum clamps it.
    void (async () => {
      if (connected) {
        await window.setSize(new LogicalSize(w, h));
        await window.setMinSize(new LogicalSize(minW, minH));
      } else {
        await window.setMinSize(new LogicalSize(minW, minH));
        await window.setSize(new LogicalSize(w, h));
      }
      await window.center();
    })();
    // Growing for the form and shrinking again are the same transition run
    // in reverse, so both directions clamp in the order set above.
  }, [connected, editorOpen]);

  // ⌘W. The menu owns the accelerator — on macOS a menu key equivalent
  // never reaches the webview, so this cannot be a keydown listener
  // (see `src-tauri/src/menu.rs`). The menu forwards the intent and the
  // decision of what to close is made here, where tab state lives.
  //
  // Held in a ref and subscribed once. Depending on `activeTab` and
  // `actions` directly would resubscribe on every render — `actions` is
  // a fresh object literal each time — and every resubscribe is an
  // async round trip to Rust with a gap in the middle where a ⌘W would
  // land on nothing.
  const onCloseTab = useRef<() => void>(() => {});
  useEffect(() => {
    onCloseTab.current = () => {
      // With no tabs left there is nothing to close but the window,
      // which is what ⌘W does everywhere else once the last tab is
      // gone.
      if (!activeTab) void getCurrentWindow().close();
      else void actions.closeTab(activeTab.id);
    };
  });

  // The rest of the tab family, on the same terms and for the same
  // reason: the menu owns the accelerator, this owns the decision. One
  // ref holding the current handlers, subscribed once — see the note
  // above for why depending on `tabs` directly would be worse.
  const tabCommands = useRef({
    next: () => {},
    previous: () => {},
    newTab: () => {},
  });
  useEffect(() => {
    // Wraps at both ends: with three tabs open, "next" from the last
    // one has an obvious answer and refusing to give it is just a dead
    // key.
    const step = (delta: number) => {
      if (tabs.length < 2) return;
      const current = tabs.findIndex((t) => t.is_active);
      const next = (current + delta + tabs.length) % tabs.length;
      void actions.activateTab(tabs[next].id);
    };
    tabCommands.current = {
      next: () => step(1),
      previous: () => step(-1),
      newTab: () => void actions.newTab(),
    };
  });

  useEffect(() => {
    const subscriptions = [
      listen("menu://close-tab", () => onCloseTab.current()),
      listen("menu://new-tab", () => tabCommands.current.newTab()),
      listen("menu://next-tab", () => tabCommands.current.next()),
      listen("menu://prev-tab", () => tabCommands.current.previous()),
    ];
    return () => {
      for (const pending of subscriptions) {
        void pending.then((unlisten) => unlisten());
      }
    };
  }, []);

  // The webview brings its own context menu — Reload and Inspect
  // Element — and it appears anywhere the app does not claim the
  // right-click for itself. Reload is the problem: this is a desktop
  // app, not a page, and reloading it drops the connection, the result
  // on screen and any staged edits, with nothing to say that is what
  // the click meant.
  //
  // Text fields keep theirs. That menu carries Cut/Copy/Paste,
  // spelling and the input methods people expect in a field, and none
  // of it is reachable any other way.
  useEffect(() => {
    function onContextMenu(e: MouseEvent) {
      const target = e.target as HTMLElement | null;
      if (
        target?.closest("input, textarea, [contenteditable='true'], .cm-editor")
      ) {
        return;
      }
      e.preventDefault();
    }
    document.addEventListener("contextmenu", onContextMenu);
    return () => document.removeEventListener("contextmenu", onContextMenu);
  }, []);

  // ⌘1…⌘9 activate a tab by position. Unlike ⌘W and ⌘T these are not
  // claimed by any menu item, so they do reach the webview and can be
  // an ordinary listener. ⌘9 is the last tab, not the ninth — the
  // convention every browser uses.
  //
  // Matched on `e.code`, the physical key, not `e.key`, the character
  // it produces. This is a positional shortcut and the digit row is not
  // where the digits live on every layout: on a French AZERTY keyboard
  // the Digit1 key types `&`, and reaching `1` needs Shift — so a
  // `/^[1-9]$/` test against `e.key` matched nothing and a `!e.shiftKey`
  // guard rejected the one chord that would have. Shift is therefore
  // ignored rather than refused, for the layouts that need it to type a
  // digit at all.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const match = /^Digit([1-9])$/.exec(e.code);
      if (!match) return;
      if (tabs.length === 0) return;
      e.preventDefault();
      const digit = Number(match[1]);
      const index = digit === 9 ? tabs.length - 1 : digit - 1;
      const target = tabs[index];
      if (target) void actions.activateTab(target.id);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs]);

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

  // The editor's text is local while typing; autosave persists it.
  const [text, setText] = useState("");

  // In-app replacements for window.prompt/confirm, which a Tauri
  // WKWebView does not implement.
  const [creating, setCreating] = useState<Creating | null>(null);
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null);
  // The save that is waiting for a name: which tab asked for it, and
  // the text it held when it did.
  //
  // Both are captured at ⌘S rather than read back when the name is
  // committed. The naming field commits on blur, and clicking another
  // tab blurs it — activating that tab first, which reseeds the editor.
  // Reading "the active tab" and "the editor text" at that moment meant
  // saving the tab you clicked, with its own text, under the name you
  // typed for a different one.
  const [naming, setNaming] = useState<{ tabId: string; sql: string } | null>(
    null,
  );

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

  // A newer published release, when there is one worth mentioning.
  const [update, setUpdate] = useState<{ version: string; url: string } | null>(
    null,
  );

  // Checked once per launch, against the public releases repo. Not a
  // background poll: a database client that talks to github.com on a
  // timer is a surprise, and once per start is enough for an app people
  // quit at the end of the day.
  useEffect(() => {
    const enabled = localStorage.getItem(UPDATE_CHECK_KEY) !== "off";
    if (!enabled) return;

    let cancelled = false;
    void (async () => {
      try {
        const [current, response] = await Promise.all([
          getVersion(),
          fetch(RELEASES_API),
        ]);
        if (!response.ok || cancelled) return;
        const release = (await response.json()) as {
          tag_name?: string;
          html_url?: string;
        };
        if (cancelled || !release.tag_name) return;

        const latest = release.tag_name.replace(/^v/i, "");
        if (
          shouldNotify({
            current,
            latest,
            dismissed: localStorage.getItem(UPDATE_DISMISSED_KEY),
            enabled: true,
          })
        ) {
          setUpdate({ version: latest, url: release.html_url ?? RELEASES_PAGE });
        }
      } catch {
        // Offline, rate-limited, or GitHub is down. An update check is
        // not worth an error in front of someone trying to run a query.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

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

  function onToggleDelete(row: number) {
    const next = toggleDelete(pending, deletes, row);
    setPending(next.pending);
    setDeletes(next.deletes);
    // The shown SQL is about a set of changes that just changed.
    setEditSql(null);
  }

  function onInsertRow() {
    // Functional update: the grid's Shift+Cmd+N listener holds this
    // callback across renders, and reading `inserts` here would let it
    // stage against a list one row out of date.
    setInserts((current) => addInsert(current));
    setEditSql(null);
  }

  function onInsertCell(id: number, column: number, value: string | null) {
    setInserts((current) => setInsertCell(current, id, column, value));
    setEditSql(null);
  }

  function onRemoveInsert(id: number) {
    setInserts((current) => removeInsert(current, id));
    setEditSql(null);
  }

  async function onViewSql() {
    if (!result) return;
    try {
      setEditSql(
        await previewEdits(
          result.edit,
          toRowEdits(pending, result),
          toRowDeletes(deletes, result),
          toRowInserts(inserts),
        ),
      );
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
        toRowDeletes(deletes, result),
        toRowInserts(inserts),
      );
      // Patch with what the database returned, not with what was
      // typed: a trigger or a type coercion may have changed it.
      // Deleted rows leave the grid, which shifts every index after
      // them. Safe only because every staged key is cleared here too.
      const count = totalPending(pending, deletes, inserts);
      setResult(applyPatches(result, applied));
      setPending(emptyPending());
      setDeletes(emptyDeletes());
      setInserts(emptyInserts());
      setSelectedRow(null);
      setEditSql(null);
      setError(null);
      // Confirming used to be the one action in the app with no
      // acknowledgement at all: the bar disappeared and that was that.
      setAppliedCount(count);
      window.setTimeout(() => setAppliedCount(null), SAVED_FLASH_MS);
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
    // A table tab has no editor buffer of its own; its Data-mode editor
    // is seeded from the table it points at, so switching to one must
    // reseed rather than leave the previous table's query on screen.
    if (activeTab.target_table) {
      const [schemaName, tableName] = [
        activeTab.target_schema ?? "public",
        activeTab.target_table,
      ];
      setTableSql(previewSql(schemaName, tableName));
      setTableSqlEdited(false);
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
      if (!activeTab) return;
      // The first edit promotes a preview to an ordinary tab, so the next
      // double-click cannot overwrite work in progress.
      if (activeTab.is_preview) void actions.promoteTab(activeTab.id);
      autosave(activeTab, value);
    },
    [activeTab, autosave, actions],
  );

  // `generated` marks the app's own preview SQL. It rides with the
  // statement rather than being re-derived later, because the same
  // string is app-written on one tab and hand-edited on the next.
  const runSql = useCallback(
    async (sql: string, generated = false, target = activeTabId) => {
      if (!connection) return;
      // The target tab is fixed before the first await and every write
      // below names it. Switching tabs mid-flight must neither move the
      // "Running…" to the tab you landed on nor drop the rows into it.
      setBusyTabId(target);
      setTabResults((all) => withResult(all, target, { error: null }));
      try {
        const next = await execute(sql, generated);
        setTabResults((all) =>
          withResult(all, target, {
            result: next,
            ranSql: sql,
            ranGenerated: generated,
            // Staged changes belong to the rows they were staged against.
            pending: emptyPending(),
            deletes: emptyDeletes(),
            inserts: emptyInserts(),
            selectedRow: null,
            editSql: null,
          }),
        );
      } catch (e) {
        // The previous result deliberately stays on screen. A sort on a
        // Data tab is a re-run, so a failed sort would otherwise throw
        // away the rows you already had — worse than the failure.
        setTabResults((all) =>
          withResult(all, target, { error: asAppError(e) }),
        );
      } finally {
        // Only if nothing else started running in the meantime.
        setBusyTabId((busy) => (busy === target ? null : busy));
        // The statement just became history, whether it worked or not.
        refreshRecent();
      }
    },
    [connection, activeTabId, refreshRecent],
  );

  // `sql` is the statement the editor extracted under the cursor;
  // omitting it runs the whole buffer, which is what ⇧⌘↵ and every
  // non-editor caller want.
  const run = useCallback(
    (sql?: string) => {
      setSort(null);
      void runSql(sql ?? text);
    },
    [runSql, text],
  );

  // Single-click in the tree: the rows, which is what you usually want
  // from a table. The tab is disposable and reused by the next click, so
  // browsing the tree does not open a tab per row — but note each click
  // does run the preview query, unlike the structure view, which renders
  // from the cached schema.
  const openTableData = useCallback(
    async (schemaName: string, tableName: string) => {
      // The preview tab is reused by the next click, so it can arrive
      // holding the previous table's sort. Clearing it on the tab we are
      // actually about to fill, rather than on whichever tab was active
      // a moment ago, is the whole point of aiming these by id.
      const target = await actions.openTableTab(
        schemaName,
        tableName,
        "data",
        "preview",
      );
      setTabResults((all) => withResult(all, target, { sort: null }));
      const sql = previewSql(schemaName, tableName);
      setTableSql(sql);
      setTableSqlEdited(false);
      await runSql(sql, true, target);
    },
    [actions, runSql],
  );

  // Structure, pinned — an explicit "keep this one". Reached from the
  // tree's context menu or ⇧↵, never from a bare click: it used to be
  // the double-click, whose first click had already opened a data tab
  // and run its query.
  const openTableStructure = useCallback(
    async (schemaName: string, tableName: string) => {
      await actions.openTableTab(schemaName, tableName, "structure", "pinned");
    },
    [actions],
  );

  // Opens, never runs — the same rule the schema tree follows. The
  // current buffer is untouched: recovering work must not cost work.
  const openRecent = useCallback(
    async (sql: string) => {
      // The tab is created holding the text. Creating it empty and
      // typing into it afterwards raced the effect that seeds the editor
      // from the active tab: the effect won, and the tab looked empty
      // until you switched away and back.
      await actions.openTabWithSql(sql);
    },
    [actions],
  );

  const forgetRecent = useCallback(async (id: string) => {
    setRecent(await forgetRecentIpc(id));
  }, []);

  const closeOtherTabs = useCallback(
    async (keepId: string) => {
      // Sequential rather than Promise.all: each close returns the new
      // tab list, and firing them together races over which reply wins.
      for (const tab of tabs.filter((t) => t.id !== keepId)) {
        await actions.closeTab(tab.id);
      }
    },
    [tabs, actions],
  );

  const changeTableMode = useCallback(
    async (next: TableMode) => {
      if (!activeTab || !tableTarget) return;
      setSort(null);
      await actions.setTabMode(activeTab.id, next);
      if (next === "data") {
        const sql = previewSql(tableTarget.schema, tableTarget.table);
        setTableSql(sql);
        setTableSqlEdited(false);
        await runSql(sql, true);
      }
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

      // An edited Data tab is somebody's own SELECT now. Regenerating the
      // preview here would silently throw their edit away on the first
      // column click, so it sorts its fetched rows instead, exactly as a
      // query tab does.
      if (!tableTarget || activeTab?.mode !== "data" || tableSqlEdited) return;

      const column = next === null ? undefined : result?.columns[next.column]?.name;
      await runSql(
        previewSql(
          tableTarget.schema,
          tableTarget.table,
          column && next ? { column, direction: next.direction } : undefined,
        ),
        true,
      );
    },
    [tableTarget, activeTab?.mode, result, runSql, tableSqlEdited],
  );

  // Whether the rows already arrived in database order. An edited Data
  // tab has not been re-run with an ORDER BY, so its rows have not.
  const serverSorted =
    tableTarget !== null && activeTab?.mode === "data" && !tableSqlEdited;

  // The rows on screen answer a statement the buffer no longer holds.
  // Not an error — they are real rows — but a grid that silently
  // belongs to an older version of the query is how you end up reading
  // the wrong answer confidently.
  const currentSql = tableTarget ? tableSql : text;
  const stale =
    result !== null && ranSql !== "" && !currentSql.includes(ranSql);

  // The app's own cap cut the rows short — a generated preview that came
  // back full. A `LIMIT` the user typed is not truncation, and saying it
  // was on every limited query is what made the flag worthless.
  const truncated =
    result !== null && isTruncated(result.rows.length, ranSql, ranGenerated);

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
    setNaming({ tabId: activeTab.id, sql: text });
  }, [activeTab, queryById, actions, text, flashSaved]);

  const commitNameAndSave = useCallback(
    async (name: string) => {
      if (!naming) return;
      const target = tabs.find((t) => t.id === naming.tabId);
      // The tab can be gone by the time a name arrives — closed from
      // another key, or closed with the field still open.
      if (!target) {
        setNaming(null);
        return;
      }
      await actions.save(target, naming.sql, name);
      setNaming(null);
      flashSaved();
    },
    [naming, tabs, actions, flashSaved],
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
        confirmLabel: "Delete query",
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
        ? "Delete this folder and everything in it? This cannot be undone."
        : "Delete this folder? This cannot be undone.";
      setConfirmRequest({
        message,
        confirmLabel: "Delete folder",
        onConfirm: () => {
          void actions.deleteCollection(id);
          setConfirmRequest(null);
        },
      });
    },
    [library, actions],
  );

  // Stable identities for the Data tab's editor. Inline arrows here would
  // change on every render — and the guard countdown re-renders this
  // component once a second — which churns the editor's own listeners.
  const onTableSqlChange = useCallback((next: string) => {
    setTableSql(next);
    setTableSqlEdited(true);
  }, []);

  const onRunTableSql = useCallback(
    (sql?: string) => run(sql ?? tableSql),
    [run, tableSql],
  );

  const switchTo = useCallback(
    async (id: string, password?: string) => {
      setConnectError(null);
      try {
        const info = await connActions.connect(id, password);
        // A cancelled or superseded attempt is not a switch and must not
        // clear anybody's rows.
        if (info === null) return;
        // Every tab, not just this one: rows fetched from the database
        // you just left are not an answer about the one you arrived at,
        // and a tab you switch to later would have shown them as if they
        // were. The tabs and their SQL survive; only the results go.
        setTabResults({});
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
        {/* Same reason as the connected layout: with no title bar, the
            webview covers the region the window is normally dragged by. */}
        <div className="drag-strip transparent" data-tauri-drag-region />
        <div className="launch-mark">
          {/* Imported rather than referenced as `/icon.png`: a public-path
              asset resolves against the dev server but not through Tauri's
              asset protocol in a built app. Importing lets Vite hash and
              bundle it, so it loads in both. */}
          <img src={iconUrl} alt="" width="64" height="64" />
          <h1>Quarry</h1>
          <p className="launch-tagline">
            A keyboard-first PostgreSQL client. Connections tagged{" "}
            <span className="tag-inline">prod</span> stay read-only until you
            unlock them.
          </p>
        </div>
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
              connectingId={connectingId}
              onCancelConnect={() => connActions.cancelConnect()}
              onPick={(id) => void switchTo(id)}
              onNew={() => setEditing("new")}
              onEdit={(id) =>
                setEditing(connections.find((c) => c.id === id) ?? "new")
              }
              onDelete={(id) =>
                setConfirmRequest({
                  message: "Delete this connection and its saved password?",
                  confirmLabel: "Delete connection",
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
      {/* The window has no title bar, so the traffic lights float over
          whatever is at the top left — here, the sidebar. This strip is
          the room they need and the only place left to drag the window
          by, since every other surface is a control or a scroll area. */}
      <div className="drag-strip" data-tauri-drag-region />
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
          onMoveQuery={(id, collectionId) => void actions.moveQuery(id, collectionId)}
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
          onOpenTableData={(s, t) => void openTableData(s, t)}
          onOpenTableStructure={(s, t) => void openTableStructure(s, t)}
          activeTable={tableTarget}
          recent={recent}
          connections={connections}
          activeConnectionId={connection?.id ?? null}
          onOpenRecent={(sql) => void openRecent(sql)}
          onForgetRecent={(id) => void forgetRecent(id)}
        />
      </div>
      <SidebarResizer onResize={setSidebarWidth} />

      <div className="main-pane" ref={paneRef}>
        {locked && (
          <div className="lock-banner">
            <span>Locked · writes and row editing are refused</span>
            <button className="btn-small" onClick={() => setUnlockOpen(true)}>
              Unlock…
            </button>
          </div>
        )}
        {unlocked && (
          <div className="unlock-banner">
            <span>
              Unlocked for writes ·{" "}
              {formatCountdown(guard?.unlocked_seconds_remaining ?? 0)}
            </span>
            <button
              className="btn-small"
              onClick={() => {
                void relock().then(async () => setGuard(await guardStatus()));
              }}
            >
              Relock
            </button>
          </div>
        )}
        {update && (
          <UpdateBanner
            version={update.version}
            url={update.url}
            onDismiss={() => {
              localStorage.setItem(UPDATE_DISMISSED_KEY, update.version);
              setUpdate(null);
            }}
            onDisable={() => {
              localStorage.setItem(UPDATE_CHECK_KEY, "off");
              setUpdate(null);
            }}
          />
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
              title={`${connection.user}@${connection.host}:${connection.port}/${connection.dbname}`}
              onClick={() => setPickerOpen((open) => !open)}
            >
              <span className="connection-name">
                {connections.find((c) => c.id === connection.id)?.name ??
                  connection.dbname}
              </span>
              {/* The tag, spelled out. It used to be a coloured dot,
                  which reads as a health light — and the one thing the
                  header must never be vague about is whether this is
                  production. */}
              {connections.find((c) => c.id === connection.id) && (
                <span
                  className="picker-tag overline"
                  style={{
                    color: connections.find((c) => c.id === connection.id)!
                      .colour,
                    borderColor: connections.find((c) => c.id === connection.id)!
                      .colour,
                  }}
                >
                  {connections.find((c) => c.id === connection.id)!.tag}
                </span>
              )}
              <span className="caret">▾</span>
            </button>

            {pickerOpen && (
              <ConnectionPicker
                connections={connections}
                activeId={connection.id}
                connectingId={connectingId}
                onCancelConnect={() => connActions.cancelConnect()}
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
                    confirmLabel: "Delete connection",
                    onConfirm: () => {
                      void connActions.remove(id);
                      setConfirmRequest(null);
                    },
                  })
                }
              />
            )}
          </div>
          {/* Demoted from a filled accent button. Saving is on ⌘S, the
              text autosaves as you type, and this was the loudest
              control in the window for the least frequent decision —
              which pulled the eye away from the connection identity
              next to it. Hidden on a table tab, where "save" has no
              query to name. */}
          {!tableTarget && (
            <button
              className="btn-small"
              title="Save this query (⌘S)"
              onClick={() => void save()}
            >
              Save
            </button>
          )}
        </header>

        <TabBar
          tabs={tabs}
          queryById={queryById}
          onActivate={(id) => void actions.activateTab(id)}
          onClose={(id) => void actions.closeTab(id)}
          onCloseOthers={(id) => void closeOtherTabs(id)}
          onNew={() => void actions.newTab()}
          namingTabId={naming?.tabId ?? null}
          onCommitName={(name) => void commitNameAndSave(name)}
          onCancelName={() => setNaming(null)}
        />

        {tableTarget ? (
          <TableView
            schemaName={tableTarget.schema}
            tableName={tableTarget.table}
            detail={detail}
            mode={activeTab?.mode ?? "structure"}
            onModeChange={(next) => void changeTableMode(next)}
            onRefreshSchema={() => void refreshDbSchema()}
            editor={
              <>
                <SqlEditor
                  value={tableSql}
                  onChange={onTableSqlChange}
                  onRun={onRunTableSql}
                  busy={busy}
                  completionSchema={completionSchema}
                  height={editorHeight}
                  onReady={onEditorReady}
                  onFormat={formatSql}
                />
                <PaneResizer
                  label="Resize editor"
                  onDrag={resizeEditor}
                  onNudge={nudgeEditor}
                />
              </>
            }
          >
            {result && (
              <>
                <GridToolbar
                  canExportSql={tableTarget !== null}
                  busy={exporting}
                  onExport={(f) => void exportResult(f)}
                  canDelete={canEditRows && selectedRow !== null}
                  deleting={selectedRow !== null && isDeleted(deletes, selectedRow)}
                  onDeleteRow={() => {
                    if (selectedRow !== null) onToggleDelete(selectedRow);
                  }}
                  canInsert={canEditRows && Boolean(result.edit.insertable)}
                  insertReason={result.edit.insert_reason}
                  onInsertRow={onInsertRow}
                />
                <ResultGrid
                  result={result}
                  sql={ranSql}
                  sort={sort}
                  onSortChange={(next) => void changeSort(next)}
                  serverSorted={serverSorted}
                  pending={canEditRows ? pending : null}
                  onStage={onStage}
                  deletes={canEditRows ? deletes : null}
                  onToggleDelete={onToggleDelete}
                  inserts={canEditRows ? inserts : null}
                  onInsertRow={onInsertRow}
                  onInsertCell={onInsertCell}
                  onRemoveInsert={onRemoveInsert}
                  onSelectRow={setSelectedRow}
                />
                {canEditRows && (
                  <EditBar
                    count={totalPending(pending, deletes, inserts)}
                    statements={editSql}
                    busy={applying}
                    onViewSql={() => void onViewSql()}
                    onHideSql={() => setEditSql(null)}
                    onCancel={() => {
                      setPending(emptyPending());
                      setDeletes(emptyDeletes());
                      setInserts(emptyInserts());
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
              height={editorHeight}
              onReady={onEditorReady}
              onFormat={formatSql}
            />
            <PaneResizer
              label="Resize editor"
              onDrag={resizeEditor}
              onNudge={nudgeEditor}
            />
            {result && (
              <>
                <GridToolbar
                  canExportSql={tableTarget !== null}
                  busy={exporting}
                  onExport={(f) => void exportResult(f)}
                  canDelete={canEditRows && selectedRow !== null}
                  deleting={selectedRow !== null && isDeleted(deletes, selectedRow)}
                  onDeleteRow={() => {
                    if (selectedRow !== null) onToggleDelete(selectedRow);
                  }}
                  canInsert={canEditRows && Boolean(result.edit.insertable)}
                  insertReason={result.edit.insert_reason}
                  onInsertRow={onInsertRow}
                />
                <ResultGrid
                  result={result}
                  sql={ranSql}
                  sort={sort}
                  onSortChange={(next) => void changeSort(next)}
                  serverSorted={serverSorted}
                  pending={canEditRows ? pending : null}
                  onStage={onStage}
                  deletes={canEditRows ? deletes : null}
                  onToggleDelete={onToggleDelete}
                  inserts={canEditRows ? inserts : null}
                  onInsertRow={onInsertRow}
                  onInsertCell={onInsertCell}
                  onRemoveInsert={onRemoveInsert}
                  onSelectRow={setSelectedRow}
                />
                {canEditRows && (
                  <EditBar
                    count={totalPending(pending, deletes, inserts)}
                    statements={editSql}
                    busy={applying}
                    onViewSql={() => void onViewSql()}
                    onHideSql={() => setEditSql(null)}
                    onCancel={() => {
                      setPending(emptyPending());
                      setDeletes(emptyDeletes());
                      setInserts(emptyInserts());
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
            <button className="btn-small" onClick={() => setUnlockOpen(true)}>
              Unlock…
            </button>
          </div>
        )}
        {/* A guard denial already has its own strip with the way out, so
            it does not also get the panel — but only when that strip is
            actually on screen. Everything else gets the panel: the
            status bar now says "see above" and nothing else, so an error
            with neither strip nor panel would leave it pointing at an
            empty space. */}
        {error && !(error.kind === "write_blocked" && locked) && (
          <ErrorPanel
            error={error}
            onGoToPosition={(position) => editor.current?.goToPosition(position)}
            onDismiss={() => setError(null)}
          />
        )}
        <StatusBar
          result={result}
          error={error}
          saved={showSaved}
          locked={locked}
          busy={busy}
          elapsed={elapsed}
          stale={stale}
          truncated={truncated}
          applied={appliedCount}
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
