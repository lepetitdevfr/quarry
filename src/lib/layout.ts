/** Below this the schema tree is unusable. */
export const MIN_SIDEBAR_WIDTH = 180;

/** Above this the sidebar starves the result grid. */
export const MAX_SIDEBAR_WIDTH = 480;

/** Width on every launch — the sidebar width is deliberately not persisted. */
export const DEFAULT_SIDEBAR_WIDTH = 260;

/**
 * Keep a dragged width inside usable bounds.
 *
 * A non-numeric input falls back to the default rather than propagating:
 * a NaN width collapses the sidebar to nothing, taking the drag handle
 * with it, and the user has no way to drag it back.
 */
export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return DEFAULT_SIDEBAR_WIDTH;
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(width)));
}
