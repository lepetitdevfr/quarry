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

/** Below this the editor shows less than two lines of SQL. */
export const MIN_EDITOR_HEIGHT = 72;

/** Height on every launch — roughly nine lines, the previous fixed size. */
export const DEFAULT_EDITOR_HEIGHT = 200;

/**
 * Keep the editor pane usable and leave room for the grid.
 *
 * The maximum is a share of the space available rather than a constant:
 * on a short window a 600px editor would push the results out entirely,
 * and the whole point of dragging this divider is to choose between the
 * two, not to lose one.
 */
export function clampEditorHeight(height: number, available: number): number {
  if (!Number.isFinite(height)) return DEFAULT_EDITOR_HEIGHT;
  // 120px is about four rows plus a header — enough for the grid to be
  // worth showing at all.
  const max = Math.max(MIN_EDITOR_HEIGHT, available - 120);
  return Math.min(max, Math.max(MIN_EDITOR_HEIGHT, Math.round(height)));
}

/** Below this the schema tree shows fewer than three rows. */
export const MIN_SECTION_HEIGHT = 80;

/** The schema section's share of the sidebar on every launch. */
export const DEFAULT_SCHEMA_HEIGHT = 300;

/**
 * Keep both sidebar sections present.
 *
 * Same shape as the editor clamp, and for the same reason: dragging the
 * divider between two lists must never dismiss one of them, because the
 * only handle that could bring it back is the divider itself.
 */
export function clampSectionHeight(height: number, available: number): number {
  if (!Number.isFinite(height)) return DEFAULT_SCHEMA_HEIGHT;
  const max = Math.max(MIN_SECTION_HEIGHT, available - MIN_SECTION_HEIGHT);
  return Math.min(max, Math.max(MIN_SECTION_HEIGHT, Math.round(height)));
}
