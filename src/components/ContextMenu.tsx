import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/** One row of a context menu. A separator carries nothing else. */
export type MenuItem =
  | { separator: true }
  | {
      separator?: false;
      label: string;
      /** Rendered right-aligned and dimmed — this is where chords stop
       *  being folklore. */
      shortcut?: string;
      danger?: boolean;
      disabled?: boolean;
      /** Shown as the row's tooltip, typically why it is disabled. */
      title?: string;
      onSelect: () => void;
    };

/** Where a menu was opened, in viewport coordinates. */
export interface MenuAnchor {
  x: number;
  y: number;
}

export interface MenuState {
  anchor: MenuAnchor;
  items: MenuItem[];
}

/**
 * Right-click menu state, shared by every surface that has one.
 *
 * `open` is meant to be handed straight to `onContextMenu`; it takes the
 * items so each call site decides what its own rows are without this
 * hook knowing anything about trees, grids or tabs.
 */
export function useContextMenu() {
  const [menu, setMenu] = useState<MenuState | null>(null);

  const open = useCallback(
    (e: React.MouseEvent, items: MenuItem[]) => {
      // Nothing to show is worse than no menu at all: an empty popover
      // looks like a broken one.
      if (items.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      setMenu({ anchor: { x: e.clientX, y: e.clientY }, items });
    },
    [],
  );

  const close = useCallback(() => setMenu(null), []);

  return { menu, open, close };
}

/**
 * The menu itself.
 *
 * Rendered `position: fixed` at the pointer and then nudged back inside
 * the window: a menu opened near the right or bottom edge otherwise
 * runs off it, and in a desktop window there is no page to scroll to
 * reach it.
 *
 * Keyboard model matches the platform: ↑/↓ move, Enter or Space
 * activates, Escape closes and returns focus to whatever opened it,
 * Home/End jump. Disabled rows are skipped rather than focused.
 */
export function ContextMenu({
  menu,
  onClose,
}: {
  menu: MenuState | null;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<MenuAnchor | null>(null);
  // What had focus when the menu opened, so Escape can give it back.
  const restoreTo = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    if (!menu) {
      setPosition(null);
      return;
    }
    restoreTo.current = document.activeElement as HTMLElement | null;

    const element = ref.current;
    if (!element) return;
    const { width, height } = element.getBoundingClientRect();
    const margin = 8;
    setPosition({
      x: Math.max(
        margin,
        Math.min(menu.anchor.x, window.innerWidth - width - margin),
      ),
      y: Math.max(
        margin,
        Math.min(menu.anchor.y, window.innerHeight - height - margin),
      ),
    });

    // Focus the first row that can actually be chosen.
    const first = element.querySelector<HTMLButtonElement>(
      "button.context-menu-item:not(:disabled)",
    );
    first?.focus();
  }, [menu]);

  // Any press outside closes, as does scrolling or resizing underneath —
  // a menu still floating over content that moved is worse than one that
  // vanished.
  useEffect(() => {
    if (!menu) return;
    function onPointerDown(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) onClose();
    }
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("resize", onClose);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("blur", onClose);
    };
  }, [menu, onClose]);

  if (!menu) return null;

  function move(delta: number) {
    const element = ref.current;
    if (!element) return;
    const rows = Array.from(
      element.querySelectorAll<HTMLButtonElement>(
        "button.context-menu-item:not(:disabled)",
      ),
    );
    if (rows.length === 0) return;
    const current = rows.indexOf(document.activeElement as HTMLButtonElement);
    // Wraps: a menu of four items should not dead-end at either edge.
    const next = (current + delta + rows.length) % rows.length;
    rows[next === -1 ? 0 : next]?.focus();
  }

  function dismiss() {
    onClose();
    restoreTo.current?.focus?.();
  }

  return (
    <div
      className="context-menu"
      role="menu"
      ref={ref}
      style={{
        left: position?.x ?? menu.anchor.x,
        top: position?.y ?? menu.anchor.y,
        // Measured before it is placed; showing it mid-measurement is a
        // visible jump from the pointer to the corrected position.
        visibility: position === null ? "hidden" : "visible",
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") {
          e.preventDefault();
          dismiss();
        } else if (e.key === "ArrowDown") {
          e.preventDefault();
          move(1);
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          move(-1);
        } else if (e.key === "Home") {
          e.preventDefault();
          move(1);
        } else if (e.key === "Tab") {
          // Tab out of a context menu means "not this after all".
          e.preventDefault();
          dismiss();
        }
      }}
    >
      {menu.items.map((item, i) =>
        item.separator ? (
          <div key={i} className="context-menu-separator" role="separator" />
        ) : (
          <button
            key={i}
            type="button"
            role="menuitem"
            className={`context-menu-item${item.danger ? " danger" : ""}`}
            disabled={item.disabled}
            title={item.title}
            onClick={() => {
              onClose();
              item.onSelect();
            }}
          >
            <span>{item.label}</span>
            {item.shortcut && <span className="shortcut">{item.shortcut}</span>}
          </button>
        ),
      )}
    </div>
  );
}
