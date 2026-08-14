# Visual Design Pass and Resizable Sidebar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every surface one spacing and type scale, and let the sidebar be dragged between 180px and 480px.

**Architecture:** Geometry tokens join the existing colour tokens in `:root`, then each component's hardcoded values are replaced with them, one component per commit so a regression is easy to bisect. The sidebar gains a drag handle whose clamp is a pure, unit-tested function; the width lives in React state and is deliberately not persisted.

**Tech Stack:** CSS custom properties, React 19 + TypeScript 7, vitest.

**Spec:** `docs/superpowers/specs/2026-08-14-visual-design-design.md`

---

## Prerequisites

- On `main`, clean tree, 160 tests passing (119 Rust + 41 TS)
- If `cargo` is missing: `export PATH="/opt/homebrew/opt/rustup/bin:$PATH"`
- **Commit messages must NOT include a `Co-Authored-By: Claude` trailer**

Create a branch:

```bash
cd /Users/lepetitdev/dev/quarry && git checkout -b design-pass
```

---

## The one rule for this plan

**This is a restyle, not a rewrite.** No component's structure, props, or
behaviour changes. If applying a token would require restructuring a component,
the token loses — leave the value hardcoded, add a comment saying why, and note
it in your report.

A corollary: **no existing test should break.** All 119 Rust and 41 TS tests must
stay green throughout. If one breaks, the change went further than a restyle.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/App.css` | *(modify)* token definitions, then every component's rules |
| `src/lib/layout.ts` | Clamp function for the sidebar width |
| `src/lib/layout.test.ts` | Vitest for the clamp |
| `src/components/SidebarResizer.tsx` | The drag handle |
| `src/App.tsx` | *(modify)* sidebar width state, render the resizer |
| `src/components/ConnectionEditor.tsx` | *(modify)* grouped sections markup |

`src/App.css` is 681 lines and growing. Splitting it is tempting but out of
scope: it would make this diff impossible to review against the "restyle only"
rule. Note it for later if it keeps growing.

---

## Task 1: Add the tokens

**Files:**
- Modify: `src/App.css`

- [ ] **Step 1: Add geometry tokens and the third grey**

In `src/App.css`, the `:root` block currently ends with `font-size: 13px;`. Add
these declarations to it, after the existing colour tokens:

```css
  /* Tertiary text: twisties, badges, section headers. Splitting this out
     of --muted is what gives the UI hierarchy — one grey for six roles
     meant nothing separated visually. */
  --faint: #6b7280;

  /* spacing — 4px base */
  --s-1: 4px;
  --s-2: 8px;
  --s-3: 12px;
  --s-4: 16px;
  --s-5: 20px;
  --s-6: 24px;

  /* control heights */
  --h-row: 26px;      /* tree rows, tabs */
  --h-control: 28px;  /* inputs, selects, buttons */

  /* type scale */
  --t-xs: 10px;       /* section headers, badges */
  --t-sm: 11px;       /* column types, definitions, hints */
  --t-base: 13px;     /* body */
  --t-lg: 15px;       /* dialog titles */

  --radius: 6px;
  --radius-lg: 10px;
```

- [ ] **Step 2: Verify nothing changed yet**

Adding unused custom properties cannot alter rendering.

```bash
cd /Users/lepetitdev/dev/quarry && npm run build 2>&1 | grep -E "built in|error"
```

Expected: `✓ built in …`.

- [ ] **Step 3: Commit**

```bash
cd /Users/lepetitdev/dev/quarry
git add src/App.css
git commit -m "style: add spacing, size, and type tokens"
```

---

## Task 2: The sidebar width clamp (TDD)

**Files:**
- Create: `src/lib/layout.ts`, `src/lib/layout.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/layout.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  clampSidebarWidth,
} from "./layout";

describe("clampSidebarWidth", () => {
  it("passes a normal width through untouched", () => {
    expect(clampSidebarWidth(300)).toBe(300);
  });

  it("stops at the minimum", () => {
    expect(clampSidebarWidth(50)).toBe(MIN_SIDEBAR_WIDTH);
    expect(clampSidebarWidth(-200)).toBe(MIN_SIDEBAR_WIDTH);
  });

  it("stops at the maximum", () => {
    expect(clampSidebarWidth(2000)).toBe(MAX_SIDEBAR_WIDTH);
  });

  it("keeps the boundaries themselves", () => {
    expect(clampSidebarWidth(MIN_SIDEBAR_WIDTH)).toBe(MIN_SIDEBAR_WIDTH);
    expect(clampSidebarWidth(MAX_SIDEBAR_WIDTH)).toBe(MAX_SIDEBAR_WIDTH);
  });

  it("falls back to the default for a value that is not a number", () => {
    // A pointer event on a detached element can yield NaN; rendering a
    // NaN-wide sidebar collapses it with no way to drag it back.
    expect(clampSidebarWidth(Number.NaN)).toBe(DEFAULT_SIDEBAR_WIDTH);
  });

  it("has a default inside its own bounds", () => {
    expect(DEFAULT_SIDEBAR_WIDTH).toBeGreaterThanOrEqual(MIN_SIDEBAR_WIDTH);
    expect(DEFAULT_SIDEBAR_WIDTH).toBeLessThanOrEqual(MAX_SIDEBAR_WIDTH);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/lepetitdev/dev/quarry && npm test 2>&1 | tail -8
```

Expected: cannot resolve `./layout`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/layout.ts`:

```typescript
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
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/lepetitdev/dev/quarry && npm test 2>&1 | tail -6
```

Expected: `Test Files 6 passed`, `Tests 47 passed` (41 existing + 6 new).

- [ ] **Step 5: Commit**

```bash
cd /Users/lepetitdev/dev/quarry
git add src/lib/layout.ts src/lib/layout.test.ts
git commit -m "feat(ui): add the sidebar width clamp"
```

---

## Task 3: The drag handle

**Files:**
- Create: `src/components/SidebarResizer.tsx`
- Modify: `src/App.tsx`, `src/App.css`

- [ ] **Step 1: Write the component**

Create `src/components/SidebarResizer.tsx`:

```tsx
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
```

- [ ] **Step 2: Wire it into App.tsx**

Add the imports:

```tsx
import { SidebarResizer } from "./components/SidebarResizer";
import { DEFAULT_SIDEBAR_WIDTH } from "./lib/layout";
```

Add the state, next to the other `useState` calls:

```tsx
  // Deliberately not persisted: one integer of UI state, restored by a
  // single drag.
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
```

In the connected view, the `<Sidebar …/>` element is rendered directly inside
`<main className="app with-sidebar">`. Wrap it so the handle sits beside it, and
pass the width as an inline style:

```tsx
      <div className="sidebar-shell" style={{ width: sidebarWidth }}>
        <Sidebar
          {/* keep every existing prop exactly as it is */}
        />
      </div>
      <SidebarResizer onResize={setSidebarWidth} />
```

Do NOT change any prop passed to `Sidebar`.

- [ ] **Step 3: Add the styles**

In `src/App.css`, change the `.sidebar` rule — it currently sets
`width: 260px; min-width: 160px;`. The width now comes from the shell, so remove
both declarations from `.sidebar` and add the shell and handle rules:

```css
.sidebar-shell {
  display: flex;
  flex: none;
  min-width: 0;
  overflow: hidden;
}

.sidebar {
  /* width now comes from .sidebar-shell's inline style */
  flex: 1;
  min-width: 0;
}

.sidebar-resizer {
  flex: none;
  width: 6px;
  margin-left: -3px;
  cursor: col-resize;
  background: transparent;
  /* Sits above the panes so the pointer always lands on the handle
     rather than on whatever is underneath it. */
  position: relative;
  z-index: 5;
}

.sidebar-resizer:hover,
.sidebar-resizer:active {
  background: var(--accent);
}
```

- [ ] **Step 4: Verify**

```bash
cd /Users/lepetitdev/dev/quarry
npx tsc --noEmit
npm test 2>&1 | tail -5
npm run build 2>&1 | grep -E "built in|error"
```

Expected: clean, 47 tests, build succeeds.

- [ ] **Step 5: Commit**

```bash
cd /Users/lepetitdev/dev/quarry
git add src/components/SidebarResizer.tsx src/App.tsx src/App.css
git commit -m "feat(ui): make the sidebar resizable by dragging its edge"
```

---

## Task 4: Apply tokens to the trees and tab bar

**Files:**
- Modify: `src/App.css`

- [ ] **Step 1: Update the tree, sidebar header, and tab rules**

Make these replacements in `src/App.css`. Each is a value swap; do not change
any selector or add any rule beyond what is shown.

`.tree-row` — currently `padding: 3px 8px;` with no height:

```css
.tree-row {
  display: flex;
  align-items: center;
  gap: var(--s-1);
  height: var(--h-row);
  padding: 0 var(--s-2);
  cursor: default;
  white-space: nowrap;
}
```

`.sidebar-header` — currently `padding: 6px 10px; font-size: 11px;`:

```css
.sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--s-2) var(--s-3);
  font-size: var(--t-xs);
  letter-spacing: 0.06em;
  color: var(--faint);
  position: sticky;
  top: 0;
  background: var(--panel);
}
```

`.twisty` — change `color: var(--muted)` to `color: var(--faint)`.

`.schema-type` — change `font-size: 11px` to `font-size: var(--t-sm)`.

`.schema-badge` — change `color: var(--muted)` to `color: var(--faint)` and
`font-size: 9px` to `font-size: var(--t-xs)`.

`.marker` — change `font-size: 9px` to `font-size: var(--t-xs)`.

`.tab` — currently `padding: 6px 10px;`:

```css
.tab {
  display: flex;
  align-items: center;
  gap: var(--s-1);
  height: var(--h-row);
  padding: 0 var(--s-3);
  border-right: 1px solid var(--border);
  color: var(--muted);
  white-space: nowrap;
}
```

`.schema-toolbar` — change `padding: 4px 6px` to `padding: var(--s-1) var(--s-2)`
and `gap: 4px` to `gap: var(--s-1)`.

`.schema-filter` — change `padding: 3px 6px` to `padding: 0 var(--s-2)`, add
`height: var(--h-control);`, change `font-size: 12px` to `font-size: var(--t-base)`,
and change `border-radius: 5px` to `border-radius: var(--radius)`.

- [ ] **Step 2: Verify the build and check the tree by eye**

```bash
cd /Users/lepetitdev/dev/quarry && npm run build 2>&1 | grep -E "built in|error"
```

Expected: build succeeds. Rows are now a uniform 26px, and the twisty column
still reserves its width on leaf rows — if children stop indenting past their
parents, the `.twisty` rule lost its `width: 12px`, put it back.

- [ ] **Step 3: Commit**

```bash
cd /Users/lepetitdev/dev/quarry
git add src/App.css
git commit -m "style: put the trees and tab bar on the scale"
```

---

## Task 5: Rebuild the connection editor

This is the surface the user complained about first. The markup gains grouping;
no field, prop, or handler changes.

**Files:**
- Modify: `src/components/ConnectionEditor.tsx`, `src/App.css`

- [ ] **Step 1: Regroup the form**

In `src/components/ConnectionEditor.tsx`, the returned JSX currently lists every
field as a flat sequence. Restructure it into the approved layout, keeping every
`value`, `onChange`, `id`, and handler exactly as it is:

```tsx
  return (
    <form className="connection-editor" onSubmit={submit}>
      <h2>{existing ? "Edit connection" : "New connection"}</h2>

      <div className="field">
        <label htmlFor="url">Paste a connection URL</label>
        <input
          id="url"
          type="text"
          placeholder="postgres://user:password@host:5432/db"
          spellCheck={false}
          onChange={(e) => applyUrl(e.target.value)}
        />
        <p className="hint">Fills in everything below.</p>
        {urlError && <p className="error">{urlError}</p>}
      </div>

      <div className="field-group">
        <div className="group-title">CONNECTION</div>

        <div className="field">
          <label htmlFor="name">Name</label>
          <input id="name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </div>

        <div className="field field-row">
          <div className="grow">
            <label htmlFor="host">Host</label>
            <input id="host" value={host} onChange={(e) => setHost(e.target.value)} />
          </div>
          <div className="narrow">
            <label htmlFor="port">Port</label>
            <input id="port" value={port} onChange={(e) => setPort(e.target.value)} />
          </div>
        </div>

        <div className="field field-row">
          <div className="grow">
            <label htmlFor="user">User</label>
            <input id="user" value={user} onChange={(e) => setUser(e.target.value)} />
          </div>
          <div className="grow">
            <label htmlFor="dbname">Database</label>
            <input id="dbname" value={dbname} onChange={(e) => setDbname(e.target.value)} />
          </div>
        </div>

        <div className="field">
          <label htmlFor="password">
            Password{" "}
            {existing && <span className="hint-inline">(blank keeps the saved one)</span>}
          </label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
      </div>

      <div className="field-group">
        <div className="group-title">ENVIRONMENT</div>

        <div className="field field-row">
          <div className="grow">
            <label htmlFor="tag">Tag</label>
            <select id="tag" value={tag} onChange={(e) => setTag(e.target.value as Tag)}>
              {TAGS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
          <div className="grow">
            <label htmlFor="sslmode">SSL mode</label>
            <select
              id="sslmode"
              value={sslmode}
              onChange={(e) => setSslmode(e.target.value as SslMode)}
            >
              {SSL_MODES.map((m) => (
                <option key={m} value={m}>
                  {SSL_MODE_LABELS[m]}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <div className="editor-actions">
        <button type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" disabled={name.trim() === ""}>
          Save
        </button>
      </div>
    </form>
  );
```

If `SSL_MODE_LABELS` is named differently in the current file, use the real
name — the labels were added when `verify-full` landed. Do not change the
options themselves.

- [ ] **Step 2: Replace the editor styles**

In `src/App.css`, replace the whole `.connection-editor` rule and its
`.connection-editor input, .connection-editor select`, `.field-row`,
`.field-row > div`, and `.hint` companions with:

```css
.connection-editor {
  display: flex;
  flex-direction: column;
  width: 380px;
  padding: var(--s-5);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--panel);
}

.connection-editor h2 {
  margin: 0 0 var(--s-4);
  font-size: var(--t-lg);
  font-weight: 600;
}

.connection-editor label {
  display: block;
  margin-bottom: var(--s-1);
  font-size: var(--t-sm);
  color: var(--muted);
}

.connection-editor input,
.connection-editor select {
  width: 100%;
  height: var(--h-control);
  padding: 0 var(--s-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg);
  color: var(--text);
  font-size: var(--t-base);
  box-sizing: border-box;
}

/* Label sits close to its field; fields sit further from each other. That
   difference is what makes the form read as groups rather than a list. */
.field + .field {
  margin-top: var(--s-3);
}

.field-group {
  margin-top: var(--s-5);
  padding-top: var(--s-4);
  border-top: 1px solid var(--border);
}

.group-title {
  margin-bottom: var(--s-3);
  font-size: var(--t-xs);
  letter-spacing: 0.08em;
  color: var(--faint);
}

.field-row {
  display: flex;
  gap: var(--s-3);
}

.field-row .grow {
  flex: 1;
  min-width: 0;
}

/* A port is five characters. Giving it half the dialog made it look
   stranded next to a full-width host. */
.field-row .narrow {
  width: 84px;
  flex: none;
}

.hint {
  margin: var(--s-1) 0 0;
  font-size: var(--t-sm);
  color: var(--faint);
}

.hint-inline {
  color: var(--faint);
  font-weight: 400;
}

.editor-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--s-2);
  margin-top: var(--s-6);
}
```

- [ ] **Step 3: Verify**

```bash
cd /Users/lepetitdev/dev/quarry
npx tsc --noEmit
npm test 2>&1 | tail -5
npm run build 2>&1 | grep -E "built in|error"
```

Expected: clean, 47 tests, build succeeds.

- [ ] **Step 4: Commit**

```bash
cd /Users/lepetitdev/dev/quarry
git add src/components/ConnectionEditor.tsx src/App.css
git commit -m "style: rebuild the connection editor on the scale"
```

---

## Task 6: Apply tokens to the remaining surfaces

**Files:**
- Modify: `src/App.css`

- [ ] **Step 1: Update buttons, grid, status bar, and picker**

`button` — currently `padding: 6px 14px; border-radius: 6px;`:

```css
button {
  height: var(--h-control);
  padding: 0 var(--s-4);
  border: none;
  border-radius: var(--radius);
  background: var(--accent);
  color: white;
  font-size: var(--t-base);
  font-weight: 500;
}
```

`.result-grid thead th` — change `padding: 6px 10px` to
`padding: var(--s-1) var(--s-3)`.

`.result-grid td` — change `padding: 4px 10px` to `padding: var(--s-1) var(--s-3)`.

`.col-type` — change `margin-left: 6px` to `margin-left: var(--s-2)` and add
`font-size: var(--t-sm);`.

`.status-bar` — change `padding: 6px 12px` to `padding: var(--s-2) var(--s-3)`.

`.picker-row` — currently `padding: 6px 8px; gap: 8px;`:

```css
.picker-row {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  flex: 1;
  height: var(--h-row);
  padding: 0 var(--s-2);
  background: transparent;
  color: var(--text);
  text-align: left;
  border-radius: var(--radius);
}
```

`.picker-tag` — change `font-size: 10px` to `font-size: var(--t-xs)` and
`color: var(--muted)` to `color: var(--faint)`.

`.picker-target` — change `font-size: 11px` to `font-size: var(--t-sm)`.

`.top-bar` — change `padding: 8px 12px` to `padding: var(--s-2) var(--s-3)`.

`.confirm-dialog` — change `padding: 16px` to `padding: var(--s-4)` and
`border-radius: 8px` to `border-radius: var(--radius-lg)`.

`.password-retry` — change `padding: 12px` to `padding: var(--s-3)`,
`gap: 6px` to `gap: var(--s-2)`, and `border-radius: 8px` to
`border-radius: var(--radius-lg)`.

- [ ] **Step 2: Check for stragglers**

```bash
cd /Users/lepetitdev/dev/quarry && grep -nE "padding: [0-9]+px|font-size: [0-9]+px|height: [0-9]+px" src/App.css
```

Every remaining hit should be deliberate — a hairline border, a fixed 84px port,
the 12px twisty column, virtualizer row heights that must match their JS
constants. Report the list with a one-line justification each; do not
mechanically tokenise a value whose exact number matters.

- [ ] **Step 3: Verify**

```bash
cd /Users/lepetitdev/dev/quarry
npm test 2>&1 | tail -5
npm run build 2>&1 | grep -E "built in|error"
```

Expected: 47 tests, build succeeds.

- [ ] **Step 4: Commit**

```bash
cd /Users/lepetitdev/dev/quarry
git add src/App.css
git commit -m "style: put the remaining surfaces on the scale"
```

---

## Task 7: Row heights must match their virtualizers

Two components virtualize rows with a JS constant that must equal the CSS row
height, or rows overlap or gap.

**Files:**
- Modify: `src/components/SchemaTree.tsx`

- [ ] **Step 1: Align the constant**

`src/components/SchemaTree.tsx` declares `const ROW_HEIGHT = 22;` and uses it for
`estimateSize` and each row's inline `height`. The CSS row height is now 26px.
Change it to:

```tsx
/** Must match --h-row in App.css: the virtualizer positions rows by this
    number, so a mismatch overlaps or gaps every row. */
const ROW_HEIGHT = 26;
```

Check `src/components/ResultGrid.tsx` too — it has its own `ROW_HEIGHT`. The
grid was not part of the density decision, so **leave it as it is** unless rows
visibly misalign; if you change it, say so and why.

- [ ] **Step 2: Verify**

```bash
cd /Users/lepetitdev/dev/quarry
npx tsc --noEmit
npm run build 2>&1 | grep -E "built in|error"
```

Expected: clean, build succeeds.

- [ ] **Step 3: Commit**

```bash
cd /Users/lepetitdev/dev/quarry
git add src/components/SchemaTree.tsx
git commit -m "fix(ui): match the virtualizer row height to the new scale"
```

---

## Task 8: Verify in the app

**Files:** none

- [ ] **Step 1: Start a database**

```bash
docker rm -f quarry-design >/dev/null 2>&1
docker run --rm -d --name quarry-design -e POSTGRES_PASSWORD=postgres -p 55432:5432 postgres:17
sleep 6
docker exec quarry-design psql -U postgres -c "
  create schema analytics;
  create table users (id serial primary key, email text not null, nickname text, tags text[]);
  create unique index users_email_key on users (email);
  create table analytics.events (user_id int references users(id), seq int, primary key (user_id, seq));
"
```

- [ ] **Step 2: Run the app**

```bash
cd /Users/lepetitdev/dev/quarry && npm run tauri dev
```

- [ ] **Step 3: Check each item**

- [ ] Dragging the sidebar edge resizes it smoothly
- [ ] The drag keeps working when the pointer passes over the editor and the grid
- [ ] It stops at roughly 180px and 480px
- [ ] Nothing overlaps or clips at the narrowest width
- [ ] Tree rows are evenly spaced, and columns indent past their table
- [ ] Twisties and badges are dimmer than column types, which are dimmer than names
- [ ] Tab bar rows match the tree's rhythm
- [ ] The connection editor matches the mockup: grouped sections, short fields, narrow port
- [ ] The result grid and status bar still look right

- [ ] **Step 4: Tear down**

```bash
docker stop quarry-design
```

- [ ] **Step 5: Full suite and tag**

```bash
cd /Users/lepetitdev/dev/quarry
npm test && npx tsc --noEmit && cd src-tauri && cargo test 2>&1 | grep -E "^test result"
cd /Users/lepetitdev/dev/quarry && git tag design-pass
```

---

## Definition of done

- Geometry and type tokens exist and are used throughout
- Three text tiers give hierarchy: `--text`, `--muted`, `--faint`
- Tree rows and tabs are 26px, and the virtualizer agrees
- The connection editor matches the approved mockup
- The sidebar drags between 180px and 480px, including over the editor
- All tests pass: 119 Rust, 47 TS
- No component's structure, props, or behaviour changed

## Deliberately not in this stage

Light mode; resizing the Schema/Queries or editor/results splits; collapsing the
sidebar; persisting the width; icons, animation, or font changes; splitting
`App.css` into per-component files.
