import { useCallback, useRef } from "react";

interface Props {
  /**
   * Called with the pointer's viewport Y while dragging. The caller
   * converts it to a height against its own container, because only the
   * caller knows which edge the handle is measuring from.
   */
  onDrag: (clientY: number) => void;
  /** Keyboard nudge, in pixels: negative shrinks, positive grows. */
  onNudge: (delta: number) => void;
  label: string;
  className?: string;
}

/**
 * Horizontal drag handle between two stacked panes.
 *
 * The vertical counterpart of `SidebarResizer`, and it uses pointer
 * capture for the same reason that one does: without it, dragging over
 * the CodeMirror editor hands the pointer to the editor and the drag
 * dies mid-gesture.
 *
 * Arrow keys resize too. A divider that can only be moved with a mouse
 * is a divider that does not exist for half the ways this app is meant
 * to be driven.
 */
export function PaneResizer({ onDrag, onNudge, label, className }: Props) {
  const dragging = useRef(false);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "row-resize";
  }, []);

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging.current) return;
      onDrag(e.clientY);
    },
    [onDrag],
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
      className={className ?? "pane-resizer"}
      role="separator"
      aria-orientation="horizontal"
      aria-label={label}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={(e) => {
        if (e.key === "ArrowUp") {
          e.preventDefault();
          onNudge(-16);
        }
        if (e.key === "ArrowDown") {
          e.preventDefault();
          onNudge(16);
        }
      }}
    />
  );
}
