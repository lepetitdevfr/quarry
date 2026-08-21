import type { RecentItem } from "../types";

/**
 * Whether a list shows only the database you are connected to.
 *
 * `here` while connected hides everything else; with no connection there
 * is nothing to scope by, so it shows everything rather than nothing —
 * an empty list would read as "you have no history" instead of "you are
 * not connected".
 */
export type Scope = "here" | "all";

/** One row of the History list, with what the view needs decided. */
export interface RecentRow {
  item: RecentItem;
  /** Whether it belongs to the connection that is live right now. */
  here: boolean;
}

/** Case-insensitive match on the SQL and, when there is one, the title. */
function matches(item: RecentItem, filter: string): boolean {
  if (filter === "") return true;
  const needle = filter.toLowerCase();
  return (
    item.sql.toLowerCase().includes(needle) ||
    (item.title ?? "").toLowerCase().includes(needle)
  );
}

/**
 * Order the list: this connection's work first, everything else below,
 * each group newest first.
 *
 * Nothing is hidden. A query written against staging has to stay
 * findable while connected to production — people reconnect precisely
 * in order to find one.
 */
export function groupRecent(
  items: RecentItem[],
  activeConnectionId: string | null,
  filter: string,
  scope: Scope = "all",
): RecentRow[] {
  const newestFirst = (a: RecentItem, b: RecentItem) =>
    a.last_at < b.last_at ? 1 : a.last_at > b.last_at ? -1 : 0;

  const scoped =
    scope === "here" && activeConnectionId !== null
      ? items.filter((i) => i.connection_id === activeConnectionId)
      : items;
  const kept = scoped.filter((i) => matches(i, filter));
  // A row whose connection was deleted belongs to nobody. It must not
  // pass as work from whatever you happen to be connected to now.
  const here = (i: RecentItem) =>
    activeConnectionId !== null && i.connection_id === activeConnectionId;

  return [
    ...kept
      .filter(here)
      .sort(newestFirst)
      .map((item) => ({ item, here: true })),
    ...kept
      .filter((i) => !here(i))
      .sort(newestFirst)
      .map((item) => ({ item, here: false })),
  ];
}

/**
 * The one quiet line under a row's SQL.
 *
 * A single run says nothing about its count; a repeated one says how
 * often, because that is the fact the collapse traded the individual
 * timings for. A failed run reports the failure and no row count: the
 * rows would be from a different attempt.
 */
export function summarise(item: RecentItem): string {
  if (item.kind === "closed") {
    return item.title ? `unsaved · ${item.title}` : "unsaved";
  }

  const parts: string[] = [];
  if (item.run_count > 1) parts.push(`${item.run_count}×`);
  if (item.error !== null) parts.push("failed");
  else if (item.row_count !== null) {
    parts.push(`${item.row_count} ${item.row_count === 1 ? "row" : "rows"}`);
  }
  return parts.join(" · ");
}
