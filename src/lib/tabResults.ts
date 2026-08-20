import type { SortState } from "./gridSort";
import {
  emptyDeletes,
  emptyInserts,
  emptyPending,
} from "./pendingEdits";
import type { Pending, PendingDeletes, PendingInserts } from "./pendingEdits";
import type {
  AppErrorPayload,
  EditStatement,
  QueryResult,
} from "../types";

/**
 * Everything on screen that belongs to one tab's last run.
 *
 * This used to be ten separate pieces of app-level state, which meant a
 * brand-new tab showed the previous tab's rows and closing a tab left
 * its grid behind. A grid that answers a question the editor above it
 * no longer asks is the failure this product exists to prevent — the
 * read path had it all along.
 */
export interface TabResult {
  result: QueryResult | null;
  error: AppErrorPayload | null;
  /** The statement behind `result`, for staleness and re-running. */
  ranSql: string;
  /** Whether that statement was the app's own generated preview. */
  ranGenerated: boolean;
  sort: SortState | null;
  pending: Pending;
  deletes: PendingDeletes;
  inserts: PendingInserts;
  selectedRow: number | null;
  editSql: EditStatement[] | null;
}

/** A tab that has not run anything: the state a fresh tab must show. */
export function emptyTabResult(): TabResult {
  return {
    result: null,
    error: null,
    ranSql: "",
    ranGenerated: false,
    sort: null,
    pending: emptyPending(),
    deletes: emptyDeletes(),
    inserts: emptyInserts(),
    selectedRow: null,
    editSql: null,
  };
}

/** Per-tab results, keyed by tab id. */
export type TabResults = Record<string, TabResult>;

/**
 * What to show for a tab. A tab with no entry has run nothing, and an
 * absent id (no tab open at all) is the same empty screen — the caller
 * should never have to special-case either.
 */
export function resultFor(all: TabResults, tabId: string | null | undefined): TabResult {
  if (!tabId) return emptyTabResult();
  return all[tabId] ?? emptyTabResult();
}

/**
 * Write part of one tab's result state, leaving every other tab alone.
 *
 * A patch against an absent id is dropped rather than stored under a
 * made-up key: results with no tab to belong to are exactly what this
 * module exists to stop.
 */
export function withResult(
  all: TabResults,
  tabId: string | null | undefined,
  patch: Partial<TabResult>,
): TabResults {
  if (!tabId) return all;
  return { ...all, [tabId]: { ...resultFor(all, tabId), ...patch } };
}

/**
 * Drop everything belonging to tabs that no longer exist.
 *
 * Closing a tab has to take its rows with it, and a session that opens
 * and closes tabs all day should not accumulate the results of every
 * one of them.
 */
export function pruneResults(all: TabResults, liveTabIds: string[]): TabResults {
  const live = new Set(liveTabIds);
  const kept: TabResults = {};
  for (const [id, entry] of Object.entries(all)) {
    if (live.has(id)) kept[id] = entry;
  }
  // Same object back when nothing was dropped. The caller prunes from an
  // effect that runs on every tab-list change, and a fresh object every
  // time would set state on every render forever.
  if (Object.keys(kept).length === Object.keys(all).length) return all;
  return kept;
}
