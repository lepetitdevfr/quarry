import { useCallback, useRef } from "react";
import { clampSidebarWidth } from "../lib/layout";

interface Props {
  onResize: (width: number) => void;
}

/**
 * Drag handle on the sidebar's right edge.
 *
 * Uses pointer capture rather than window mouse listeners: without it,
 * dragging across the CodeMirror editor hands the pointer to the editor
 * and the drag dies mid-gesture.
 */
export function SidebarResizer({ onResize }: Props) {
  const dragging = useRef(false);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    // Without this the drag selects text across the whole app.
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
  }, []);

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging.current) return;
      // clientX is the distance from the window's left edge, and the
      // sidebar starts there, so it is the width directly.
      onResize(clampSidebarWidth(e.clientX));
    },
    [onResize],
  );

  const endDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    dragging.current = false;
    e.currentTarget.releasePointerCapture(e.pointerId);
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
  }, []);

  return (
    <div
      className="sidebar-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    />
  );
}
