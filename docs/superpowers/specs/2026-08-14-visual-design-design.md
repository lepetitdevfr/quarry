# Visual Design Pass and Resizable Sidebar — Design Spec

**Date:** 2026-08-14
**Status:** Approved, ready for implementation planning

Give the app one spacing and type scale instead of per-component guesses, and
let the sidebar be dragged to any width.

---

## 1. Motivation

Two rounds of feedback, both pointing at the same cause:

> "margins are not good and elements size are weird"

> "it's not really readable"

`App.css` tokenises colour but not geometry. Six spacing values, four control
heights, and four font sizes appear across the file, each chosen by hand for the
component being written at the time. Nothing is systematically wrong; nothing is
systematically right either.

Separately, the sidebar is a fixed 240px — too narrow for a qualified index name
and unchangeable.

## 2. Scope

### In scope

- Spacing, control-height, type, and radius tokens in `:root`
- Splitting `--muted` into two tiers so hierarchy exists
- Applying tokens across every component
- 26px rows in the schema tree, query tree, and tab bar
- The connection editor rebuilt to the approved mockup
- A draggable sidebar edge, clamped

### Out of scope

- **Light mode.** Dark only, as today.
- Resizing anything else — the Schema/Queries split, the editor/results split,
  and collapsing the sidebar were all considered and cut
- Any change to component structure or behaviour. This is a restyle: if a token
  cannot be applied without restructuring a component, the token loses
- New colours beyond splitting the existing grey into two tiers
- Icons, animation, or transitions
- Font changes — the system stack stays

## 3. Decisions

**26px rows.** Chosen from three mockups (22 / 26 / 32). Readable without
sacrificing much of what fits on screen.

**The width is not persisted.** It lives in React state and returns to its
default on restart. Persisting it — in `localStorage` or the workspace database
— was considered and cut: it is one integer of pure UI state, and restoring it
costs a drag. Tabs and queries stay in the database because losing those would
cost real work.

**Pointer events with capture, not mouse events.** Dragging across the
CodeMirror editor loses a plain `mousemove` listener; pointer capture does not.

**Only the sidebar resizes.** Each additional draggable divider is another piece
of persisted state and another interaction to get right. The sidebar was the
actual request.

## 4. Tokens

Added to the existing `:root` block in `src/App.css`:

```css
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

### Colour hierarchy

`--muted` currently colours column types, badges, twisties, definitions, hints,
and section headers alike — six roles, one value, no hierarchy. It splits:

| Token | Value | Used for |
|---|---|---|
| `--text` | `#e5e7eb` | Primary text (unchanged) |
| `--muted` | `#8b93a1` | Secondary: column types, hints, status bar (unchanged value) |
| `--faint` | `#6b7280` | Tertiary: twisties, badges, section headers |

No new hues. Existing colour tokens keep their values.

## 5. The resizable sidebar

A 6px-wide handle on the sidebar's right edge, `cursor: col-resize`, showing the
accent colour on hover and while dragging.

- **Clamp:** 180px minimum, 480px maximum. Below 180 the tree is unusable; above
  480 it starves the result grid.
- **Default:** 260px on every launch. The width is deliberately not persisted.
- **Mechanics:** `pointerdown` on the handle calls `setPointerCapture`, so
  `pointermove` keeps firing over the editor and the result grid.
- **Text selection:** disabled on the body while dragging, otherwise the drag
  selects text across the app.

The clamp is a pure exported function so it can be tested without a DOM.

## 6. Component application

| Surface | Change |
|---|---|
| Schema tree, query tree | Row height `--h-row`; twisties `--faint`; types `--muted`; badges `--faint` at `--t-xs` |
| Tab bar | Tab height `--h-row`; padding `--s-2` / `--s-3` |
| Sidebar headers | `--t-xs`, `--faint`, padding `--s-2` `--s-3` |
| Connection editor | Grouped sections per the approved mockup: `--h-control` fields, 84px port, label→field `--s-1`, field→field `--s-3`, group→group `--s-5`, dialog padding `--s-5` |
| Connection picker | Row height `--h-row`, padding on the scale |
| Result grid | Header and cells on `--s-1`/`--s-3` padding; header `--t-sm` |
| Status bar | `--s-2` `--s-3`, `--muted` |
| Buttons | `--h-control`, `--radius`, `--t-base` |

Sidebar default width moves from 240px to 260px, then becomes user-controlled.

## 7. Testing

- **Unit (vitest):** the clamp function — below minimum, above maximum, and
  within range.
- **Visual:** verified by the user in the running app. Automated screenshot
  testing is not worth its setup and maintenance for a solo project.
- **Regression:** all 119 Rust and 41 TS tests stay green. Nothing in this change
  should be visible to a single existing test — if one breaks, the change went
  further than a restyle and needs re-examining.

## 8. Verification checklist

The things a user can actually see, to be checked in the app:

- Sidebar drags smoothly, including when the pointer crosses the editor
- It stops at 180px and 480px
- Tree rows are 26px and children indent past their parents
- The connection editor matches the mockup
- Nothing overlaps or clips at the minimum sidebar width

## 9. Deferred

Still in `docs/BACKLOG.md`: views in the schema tree, double-click to preview a
table, insert-name-at-cursor, copy DDL, and moving queries between collections.

Not yet built, and the largest outstanding risk: **the production write-guard.**
Switching to a production database now takes two clicks and nothing prevents a
stray `DELETE`.
