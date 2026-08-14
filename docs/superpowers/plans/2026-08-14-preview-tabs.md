# Preview Tabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Double-clicking a table in the schema tree opens a transient preview tab running `select * from "schema"."table" limit 500`, reusing one slot VS Code style and promoting to a normal tab on first edit.

**Architecture:** The `tabs` table gains `is_preview` and `title`, with `SCHEMA_VERSION` going to 3; transience is enforced by deleting preview rows during migration, so there is no restore path to get wrong. The store reuses a single preview slot, and the first edit clears the flag so a tab you have typed into is never destroyed by the next preview.

**Tech Stack:** Rust (`rusqlite`), React 19 + TypeScript 7, vitest.

**Decisions taken before writing this plan:** `limit 500`; one reused slot; editing promotes; previews do not survive a restart.

---

## Prerequisites

- On `main`, clean tree, 166 tests passing (119 Rust + 47 TS)
- If `cargo` is missing: `export PATH="/opt/homebrew/opt/rustup/bin:$PATH"`
- Docker running for integration tests
- **Commit messages must NOT include a `Co-Authored-By: Claude` trailer**

Create a branch:

```bash
cd /Users/lepetitdev/dev/quarry && git checkout -b preview-tabs
```

---

## Migration safety

The user has a real workspace database at
`~/Library/Application Support/com.quarry.app/workspace.db` holding their saved
queries and open tabs. This migration ADDS columns to an existing table, which
`create table if not exists` will NOT do on its own — Task 1 handles that
explicitly and tests that existing rows survive.

---

## File Structure

### Rust (`src-tauri/`)

| File | Responsibility |
|---|---|
| `src/library/db.rs` | *(modify)* add columns, bump version, purge previews on open |
| `src/library/model.rs` | *(modify)* `Tab` gains `is_preview` and `title` |
| `src/library/store.rs` | *(modify)* `open_preview_tab`, `promote_tab`, updated tab reads |
| `src/commands.rs` | *(modify)* two commands |
| `src/lib.rs` | *(modify)* register them |
| `tests/library_test.rs` | *(modify)* slot reuse, promotion, transience |

### TypeScript (`src/`)

| File | Responsibility |
|---|---|
| `src/types.ts` | *(modify)* `Tab` gains the two fields |
| `src/lib/ipc.ts` | *(modify)* two wrappers |
| `src/lib/schema.ts` | *(modify)* `previewSql`, plus table identity on rows |
| `src/lib/schema.test.ts` | *(modify)* quoting and limit tests |
| `src/hooks/useLibrary.ts` | *(modify)* `openPreview`, `promoteTab` |
| `src/components/SchemaTree.tsx` | *(modify)* double-click handler |
| `src/components/Sidebar.tsx` | *(modify)* pass the callback |
| `src/components/TabBar.tsx` | *(modify)* italic preview label |
| `src/App.tsx` | *(modify)* `runSql` split, preview wiring, promote on edit |
| `src/App.css` | *(modify)* preview tab styling |

---

## Task 1: Schema migration (TDD)

**Files:**
- Modify: `src-tauri/src/library/db.rs`

- [ ] **Step 1: Write the failing tests**

Add to the test module in `src-tauri/src/library/db.rs`:

```rust
    #[test]
    fn adds_preview_columns_to_an_existing_tabs_table() {
        // The user has a real database on disk with tabs in it. Adding a
        // column to an existing table is exactly where a migration can
        // cost someone their work, so this proves both halves: the new
        // columns exist, and the old rows are still there.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("w.db");

        {
            let conn = open(&path).unwrap();
            conn.execute(
                "insert into tabs (id, query_id, scratch_sql, position, is_active, cursor_pos)
                 values ('t1', null, 'select 1', 100, 1, 0)",
                [],
            )
            .unwrap();
        }

        let conn = open(&path).unwrap();

        let sql: String = conn
            .query_row("select scratch_sql from tabs where id = 't1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(sql, "select 1", "an existing tab must survive the migration");

        let is_preview: i64 = conn
            .query_row("select is_preview from tabs where id = 't1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(is_preview, 0, "existing tabs default to not-preview");

        let title: Option<String> = conn
            .query_row("select title from tabs where id = 't1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(title, None);
    }

    #[test]
    fn purges_preview_tabs_when_the_database_is_opened() {
        // Previews are transient. Deleting them at open time is simpler
        // and more robust than filtering them on restore: a crash cannot
        // leave one behind.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("w.db");

        {
            let conn = open(&path).unwrap();
            conn.execute(
                "insert into tabs (id, query_id, scratch_sql, position, is_active, cursor_pos, is_preview, title)
                 values ('keep', null, 'select 1', 100, 0, 0, 0, null),
                        ('gone', null, 'select 2', 200, 1, 0, 1, 'users')",
                [],
            )
            .unwrap();
        }

        let conn = open(&path).unwrap();

        let remaining: Vec<String> = conn
            .prepare("select id from tabs order by id")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();

        assert_eq!(remaining, vec!["keep"], "the preview tab must be gone");
    }
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/lepetitdev/dev/quarry/src-tauri && cargo test --lib library::db 2>&1 | tail -15
```

Expected: both fail — `no such column: is_preview`.

- [ ] **Step 3: Write the migration**

In `src-tauri/src/library/db.rs`:

1. Change `SCHEMA_VERSION` from `2` to `3`.

2. Add the two columns to the `create table if not exists tabs (…)` statement so
   a fresh database gets them directly:

```sql
        create table if not exists tabs (
            id          text primary key,
            query_id    text references queries(id) on delete cascade,
            scratch_sql text,
            position    integer not null,
            is_active   integer not null default 0,
            cursor_pos  integer not null default 0,
            is_preview  integer not null default 0,
            title       text
        );
```

3. `create table if not exists` does nothing to an existing table, so add an
   explicit upgrade after the `execute_batch` call and before the
   `schema_version` upsert:

```rust
    // `create table if not exists` leaves an existing table alone, so a
    // database created before version 3 still lacks these columns. SQLite
    // has no `add column if not exists`, and re-adding one is an error
    // rather than a no-op — so ask first.
    add_column_if_missing(conn, "tabs", "is_preview", "integer not null default 0")?;
    add_column_if_missing(conn, "tabs", "title", "text")?;

    // Preview tabs are transient. Purging them here rather than filtering
    // them on restore means a crash cannot leave one behind.
    conn.execute("delete from tabs where is_preview = 1", [])
        .map_err(|e| AppError::Library(e.to_string()))?;
```

4. Add the helper at the bottom of the file:

```rust
/// Add a column unless the table already has it.
///
/// SQLite has no `add column if not exists`, and adding a duplicate is a
/// hard error, so the column list has to be read first.
fn add_column_if_missing(
    conn: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> Result<(), AppError> {
    let mut stmt = conn
        .prepare(&format!("pragma table_info({table})"))
        .map_err(|e| AppError::Library(e.to_string()))?;

    let existing: Vec<String> = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| AppError::Library(e.to_string()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| AppError::Library(e.to_string()))?;

    if existing.iter().any(|c| c == column) {
        return Ok(());
    }

    conn.execute(
        &format!("alter table {table} add column {column} {definition}"),
        [],
    )
    .map_err(|e| AppError::Library(e.to_string()))?;

    Ok(())
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/lepetitdev/dev/quarry/src-tauri && cargo test --lib library::db 2>&1 | tail -12
```

Expected: `test result: ok. 8 passed` (6 existing + 2 new).

- [ ] **Step 5: Commit**

```bash
cd /Users/lepetitdev/dev/quarry
git add src-tauri/src/library/db.rs
git commit -m "feat(library): add preview tab columns and purge previews on open"
```

---

## Task 2: Store support (TDD)

**Files:**
- Modify: `src-tauri/src/library/model.rs`, `src-tauri/src/library/store.rs`
- Modify: `src-tauri/tests/library_test.rs`

- [ ] **Step 1: Write the failing tests**

Append to `src-tauri/tests/library_test.rs`:

```rust
#[test]
fn opens_a_preview_tab() {
    let (store, _dir) = store();

    let tabs = store
        .open_preview_tab("users", "select * from users limit 500")
        .unwrap();

    assert_eq!(tabs.len(), 1);
    assert!(tabs[0].is_preview);
    assert_eq!(tabs[0].title.as_deref(), Some("users"));
    assert_eq!(tabs[0].scratch_sql.as_deref(), Some("select * from users limit 500"));
    assert!(tabs[0].is_active, "a preview opens focused");
}

#[test]
fn a_second_preview_reuses_the_same_slot() {
    let (store, _dir) = store();

    store.open_preview_tab("users", "select * from users limit 500").unwrap();
    let tabs = store
        .open_preview_tab("events", "select * from events limit 500")
        .unwrap();

    let previews: Vec<_> = tabs.iter().filter(|t| t.is_preview).collect();
    assert_eq!(previews.len(), 1, "previews must not pile up");
    assert_eq!(previews[0].title.as_deref(), Some("events"));
    assert_eq!(
        previews[0].scratch_sql.as_deref(),
        Some("select * from events limit 500"),
    );
}

#[test]
fn a_preview_does_not_disturb_ordinary_tabs() {
    let (store, _dir) = store();
    let q = store.create_query("saved", "select 1", None).unwrap();
    store.open_tab(Some(&q.id)).unwrap();

    let tabs = store.open_preview_tab("users", "select * from users").unwrap();

    assert_eq!(tabs.len(), 2);
    assert_eq!(tabs.iter().filter(|t| !t.is_preview).count(), 1);
}

#[test]
fn promoting_clears_the_preview_flag() {
    let (store, _dir) = store();
    let tabs = store.open_preview_tab("users", "select * from users").unwrap();
    let id = tabs[0].id.clone();

    store.promote_tab(&id).unwrap();

    let after = store.tabs().unwrap();
    assert!(!after[0].is_preview);
    assert_eq!(
        after[0].title.as_deref(),
        Some("users"),
        "the label stays — only its disposability changes",
    );
}

#[test]
fn a_promoted_tab_is_not_reused_by_the_next_preview() {
    // The whole point of promotion: a tab you have started editing must
    // never be destroyed by the next double-click.
    let (store, _dir) = store();
    let first = store.open_preview_tab("users", "select * from users").unwrap();
    let id = first[0].id.clone();
    store.promote_tab(&id).unwrap();

    let tabs = store.open_preview_tab("events", "select * from events").unwrap();

    assert_eq!(tabs.len(), 2, "the promoted tab survives");
    assert!(tabs.iter().any(|t| t.id == id && !t.is_preview));
    assert!(tabs.iter().any(|t| t.is_preview && t.title.as_deref() == Some("events")));
}

#[test]
fn preview_tabs_do_not_survive_reopening() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("w.db");

    {
        let store = Store::open_at(&path).unwrap();
        store.open_preview_tab("users", "select * from users").unwrap();
        assert_eq!(store.tabs().unwrap().len(), 1);
    }

    let store = Store::open_at(&path).unwrap();
    assert!(store.tabs().unwrap().is_empty(), "previews are transient");
}
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/lepetitdev/dev/quarry/src-tauri && cargo test --test library_test 2>&1 | tail -15
```

Expected: compilation failure — `no method named open_preview_tab`.

- [ ] **Step 3: Extend the model**

In `src-tauri/src/library/model.rs`, add two fields to `Tab`:

```rust
pub struct Tab {
    pub id: String,
    pub query_id: Option<String>,
    pub scratch_sql: Option<String>,
    pub position: i64,
    pub is_active: bool,
    pub cursor_pos: i64,
    /// A transient tab opened by previewing a table. Reused by the next
    /// preview, and cleared by the first edit.
    pub is_preview: bool,
    /// Label for a tab with no saved query behind it — the table name
    /// for a preview. `None` for ordinary tabs, which take their label
    /// from their query.
    pub title: Option<String>,
}
```

- [ ] **Step 4: Update every tab read**

In `src-tauri/src/library/store.rs`, find `read_tab` and the `tabs()` query.
Both select the tab columns explicitly. Add the two new columns to each
`select` list and to the struct construction, in the same order:

```rust
        "select id, query_id, scratch_sql, position, is_active, cursor_pos,
                is_preview, title
         from tabs …"
```

and in the row mapping:

```rust
                is_preview: row.get::<_, i64>(6)? != 0,
                title: row.get(7)?,
```

Adjust the indices if the existing code reads columns by index and the order
differs — the two new columns must be last in both the select and the mapping.

- [ ] **Step 5: Add the store methods**

Add to the `impl Store` block in `src-tauri/src/library/store.rs`, near the
other tab methods:

```rust
    /// Open a table preview, reusing the existing preview slot if there
    /// is one.
    ///
    /// This is why previews do not pile up: double-clicking ten tables
    /// leaves one tab, not ten. A preview that has been promoted (the
    /// user edited it) is an ordinary tab and is never reused here.
    pub fn open_preview_tab(&self, title: &str, sql: &str) -> Result<Vec<Tab>, AppError> {
        let conn = self.lock();

        let existing: Option<String> = conn
            .query_row("select id from tabs where is_preview = 1 limit 1", [], |r| {
                r.get(0)
            })
            .ok();

        let id = match existing {
            Some(id) => {
                conn.execute(
                    "update tabs set title = ?2, scratch_sql = ?3, cursor_pos = 0
                     where id = ?1",
                    params![id, title, sql],
                )
                .map_err(sql_err)?;
                id
            }
            None => {
                let id = new_id();
                let position: i64 = conn
                    .query_row("select coalesce(max(position), 0) + 100 from tabs", [], |r| {
                        r.get(0)
                    })
                    .map_err(sql_err)?;

                conn.execute(
                    "insert into tabs
                       (id, query_id, scratch_sql, position, is_active, cursor_pos,
                        is_preview, title)
                     values (?1, null, ?2, ?3, 0, 0, 1, ?4)",
                    params![id, sql, position, title],
                )
                .map_err(sql_err)?;
                id
            }
        };

        activate(&conn, &id)?;
        drop(conn);
        self.tabs()
    }

    /// Turn a preview into an ordinary tab.
    ///
    /// Called on the first edit: once there is work in a tab, the next
    /// preview must open elsewhere rather than overwriting it.
    pub fn promote_tab(&self, id: &str) -> Result<(), AppError> {
        self.lock()
            .execute("update tabs set is_preview = 0 where id = ?1", params![id])
            .map_err(sql_err)?;
        Ok(())
    }
```

- [ ] **Step 6: Run tests to verify they pass**

```bash
cd /Users/lepetitdev/dev/quarry/src-tauri && cargo test --test library_test 2>&1 | tail -12
```

Expected: `test result: ok. 31 passed` (25 existing + 6 new).

- [ ] **Step 7: Run the whole Rust suite**

```bash
cd /Users/lepetitdev/dev/quarry/src-tauri && cargo test 2>&1 | grep -E "^test result|^error"
```

Expected: all suites `ok`, no regressions.

- [ ] **Step 8: Commit**

```bash
cd /Users/lepetitdev/dev/quarry
git add src-tauri/src/library src-tauri/tests/library_test.rs
git commit -m "feat(library): reuse one preview tab slot and promote on demand"
```

---

## Task 3: Commands

**Files:**
- Modify: `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`

- [ ] **Step 1: Add the commands**

Append to `src-tauri/src/commands.rs`, beside the other tab commands:

```rust
#[tauri::command]
pub fn open_preview_tab(
    state: tauri::State<'_, AppState>,
    title: String,
    sql: String,
) -> Result<Vec<Tab>, AppError> {
    state.library.open_preview_tab(&title, &sql)
}

#[tauri::command]
pub fn promote_tab(
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<Vec<Tab>, AppError> {
    state.library.promote_tab(&id)?;
    state.library.tabs()
}
```

- [ ] **Step 2: Register them**

Add to `generate_handler!` in `src-tauri/src/lib.rs`:

```rust
            commands::open_preview_tab,
            commands::promote_tab,
```

- [ ] **Step 3: Verify**

```bash
cd /Users/lepetitdev/dev/quarry/src-tauri && cargo test 2>&1 | grep -E "^test result|^error"
```

Expected: all `ok`.

- [ ] **Step 4: Commit**

```bash
cd /Users/lepetitdev/dev/quarry
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(ipc): expose preview tab commands"
```

---

## Task 4: TypeScript helper and types (TDD)

**Files:**
- Modify: `src/lib/schema.ts`, `src/lib/schema.test.ts`, `src/types.ts`, `src/lib/ipc.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/schema.test.ts`:

```typescript
describe("previewSql", () => {
  it("qualifies and quotes the table", () => {
    expect(previewSql("public", "users")).toBe(
      'select * from "public"."users" limit 500',
    );
  });

  it("survives a name that needs quoting", () => {
    // An unquoted mixed-case or reserved-word name silently resolves to
    // something else, or fails outright.
    expect(previewSql("public", "Order")).toBe(
      'select * from "public"."Order" limit 500',
    );
  });

  it("escapes an embedded double quote", () => {
    // Legal in Postgres, and the only way this builds broken SQL.
    expect(previewSql("public", 'we"ird')).toBe(
      'select * from "public"."we""ird" limit 500',
    );
  });
});
```

Also extend the existing `flattenSchema` describe block with:

```typescript
  it("carries table identity on table rows", () => {
    const rows = flattenSchema(SCHEMA, new Set(["schema:public"]), "");
    const users = rows.find((r) => r.label === "users")!;
    expect(users.tableSchema).toBe("public");
    expect(users.tableName).toBe("users");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/lepetitdev/dev/quarry && npm test 2>&1 | tail -8
```

Expected: `previewSql` is not exported; `tableSchema` is undefined.

- [ ] **Step 3: Add the helper and row fields**

In `src/lib/schema.ts`, add to the `SchemaRow` interface:

```typescript
  /** Table rows only — identity for previewing. */
  tableSchema?: string;
  tableName?: string;
```

In `flattenSchema`, where a table row is pushed, add the two fields:

```typescript
      rows.push({
        id: tableId,
        kind: "table",
        label: table.name,
        depth: 1,
        expandable: true,
        tableSchema: table.schema,
        tableName: table.name,
      });
```

Add the helper at the end of the file:

```typescript
/** How many rows a table preview fetches. */
export const PREVIEW_LIMIT = 500;

/**
 * Quote a Postgres identifier.
 *
 * Unquoted identifiers are folded to lower case, so a table created as
 * "Order" would not be found, and a reserved word would not parse at
 * all. A literal double quote inside a name is escaped by doubling it.
 */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** The SQL a table preview runs. */
export function previewSql(schema: string, table: string): string {
  return `select * from ${quoteIdent(schema)}.${quoteIdent(table)} limit ${PREVIEW_LIMIT}`;
}
```

- [ ] **Step 4: Update the Tab type and IPC**

In `src/types.ts`, add to `Tab`:

```typescript
  is_preview: boolean;
  title: string | null;
```

In `src/lib/ipc.ts`, add:

```typescript
export async function openPreviewTab(title: string, sql: string): Promise<Tab[]> {
  return invoke<Tab[]>("open_preview_tab", { title, sql });
}

export async function promoteTab(id: string): Promise<Tab[]> {
  return invoke<Tab[]>("promote_tab", { id });
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd /Users/lepetitdev/dev/quarry && npm test 2>&1 | tail -6
```

Expected: `Tests 51 passed` (47 existing + 4 new).

- [ ] **Step 6: Commit**

```bash
cd /Users/lepetitdev/dev/quarry
git add src/lib/schema.ts src/lib/schema.test.ts src/types.ts src/lib/ipc.ts
git commit -m "feat(ui): add preview SQL helper and preview tab IPC"
```

---

## Task 5: Wire the UI

**Files:**
- Modify: `src/hooks/useLibrary.ts`, `src/components/SchemaTree.tsx`, `src/components/Sidebar.tsx`, `src/components/TabBar.tsx`, `src/App.tsx`, `src/App.css`

- [ ] **Step 1: Add the hook actions**

In `src/hooks/useLibrary.ts`, add to the `actions` object beside `newTab`:

```typescript
    openPreview: async (title: string, sql: string) =>
      setTabs(await ipc.openPreviewTab(title, sql)),
    promoteTab: async (id: string) => setTabs(await ipc.promoteTab(id)),
```

- [ ] **Step 2: Emit double-clicks from the tree**

In `src/components/SchemaTree.tsx`, add to `Props`:

```tsx
  onPreviewTable: (schema: string, table: string) => void;
```

Destructure it in the component signature, then add a double-click handler to
the row element, beside the existing `onClick`:

```tsx
                onDoubleClick={() => {
                  if (row.kind === "table" && row.tableSchema && row.tableName) {
                    onPreviewTable(row.tableSchema, row.tableName);
                  }
                }}
```

The single-click expand behaviour stays exactly as it is: a double-click fires
`onClick` twice as well, which toggles the node open and shut again, leaving it
as it was. That is acceptable and is what most tree UIs do.

- [ ] **Step 3: Pass it through the sidebar**

In `src/components/Sidebar.tsx`, add to `Props`:

```tsx
  onPreviewTable: (schema: string, table: string) => void;
```

and pass it to `<SchemaTree>`:

```tsx
          onPreviewTable={props.onPreviewTable}
```

- [ ] **Step 4: Label preview tabs**

In `src/components/TabBar.tsx`, the label currently comes from
`query?.name ?? "untitled"`. A preview tab has no query but does have a title:

```tsx
        const query = queryById(tab.query_id);
        const label = query?.name ?? tab.title ?? "untitled";
```

and add the class so it can be styled:

```tsx
            className={`tab${tab.is_active ? " active" : ""}${tab.is_preview ? " preview" : ""}`}
```

- [ ] **Step 5: Split `run` so it can execute given SQL**

In `src/App.tsx`, `run` currently closes over `text`. Executing a preview right
after opening it would run the PREVIOUS tab's SQL, because `text` has not
updated yet. Replace `run` with:

```tsx
  const runSql = useCallback(
    async (sql: string) => {
      if (!connection) return;
      setBusy(true);
      setError(null);
      try {
        setResult(await execute(sql));
      } catch (e) {
        setError(asAppError(e));
        setResult(null);
      } finally {
        setBusy(false);
      }
    },
    [connection],
  );

  const run = useCallback(() => void runSql(text), [runSql, text]);
```

`run` is passed to `SqlEditor` and the keymap, so it must stay a
zero-argument function.

- [ ] **Step 6: Wire the preview**

Add to `src/App.tsx`, after `runSql`:

```tsx
  const previewTable = useCallback(
    async (schemaName: string, tableName: string) => {
      const sql = previewSql(schemaName, tableName);
      // Open the tab first: the effect keyed on the active tab id loads
      // its text into the editor, so creating the tab before running
      // keeps the editor and the results showing the same query.
      await actions.openPreview(tableName, sql);
      setText(sql);
      await runSql(sql);
    },
    [actions, runSql],
  );
```

Import the helper:

```tsx
import { buildCompletionSchema, previewSql } from "./lib/schema";
```

Pass the callback to `<Sidebar>`:

```tsx
        onPreviewTable={(s, t) => void previewTable(s, t)}
```

- [ ] **Step 7: Promote on first edit**

Still in `src/App.tsx`, `onChange` currently sets text and autosaves. A preview
being edited must stop being disposable:

```tsx
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
```

- [ ] **Step 8: Style the preview tab**

Append to `src/App.css`:

```css
/* A preview tab is disposable until edited — italic marks it as such,
   the same signal VS Code uses. */
.tab.preview .tab-label {
  font-style: italic;
}
```

- [ ] **Step 9: Verify**

```bash
cd /Users/lepetitdev/dev/quarry
npx tsc --noEmit
npm test 2>&1 | tail -5
npm run build 2>&1 | grep -E "built in|error"
```

Expected: clean, 51 tests, build succeeds.

- [ ] **Step 10: Commit**

```bash
cd /Users/lepetitdev/dev/quarry
git add src/hooks/useLibrary.ts src/components/SchemaTree.tsx src/components/Sidebar.tsx src/components/TabBar.tsx src/App.tsx src/App.css
git commit -m "feat(ui): preview a table by double-clicking it"
```

---

## Task 6: Row numbers in the result grid

Unrelated to previews, but small and in the same file neighbourhood.

**Files:**
- Modify: `src/components/ResultGrid.tsx`, `src/App.css`

- [ ] **Step 1: Add the gutter column**

In `src/components/ResultGrid.tsx`, add a header cell before the mapped columns:

```tsx
        <thead>
          <tr>
            {/* Ordinal gutter. Empty header: numbering the numbering
                column would be noise. */}
            <th className="row-num" aria-label="Row number" />
            {result.columns.map((c, i) => (
              // Column names can repeat (e.g. `SELECT 1 as n, 2 as n`), so
              // the index is used as the key instead of the name.
              <th key={i} title={c.type_name}>
                {c.name}
                <span className="col-type">{c.type_name}</span>
              </th>
            ))}
          </tr>
        </thead>
```

And a matching cell at the start of each body row, before `row.map(...)`:

```tsx
                <td className="row-num">{item.index + 1}</td>
```

`item.index` is the virtualizer's absolute row index, so numbering stays
correct while scrolling — a counter over the rendered window would restart
at 1 every time you scrolled.

- [ ] **Step 2: Style it**

Append to `src/App.css`:

```css
/* Ordinal gutter: present but recessive — it is scaffolding, not data. */
.result-grid .row-num {
  width: 52px;
  color: var(--faint);
  text-align: right;
  font-variant-numeric: tabular-nums;
  user-select: none;
}
```

`table-layout: fixed` is already set on the grid, so the fixed width holds and
the data columns share what is left.

- [ ] **Step 3: Verify**

```bash
cd /Users/lepetitdev/dev/quarry
npx tsc --noEmit
npm run build 2>&1 | grep -E "built in|error"
```

Expected: clean, build succeeds.

- [ ] **Step 4: Commit**

```bash
cd /Users/lepetitdev/dev/quarry
git add src/components/ResultGrid.tsx src/App.css
git commit -m "feat(ui): number the rows in the result grid"
```

---

## Task 7: Verify in the app

**Files:** none

- [ ] **Step 1: Start a database**

```bash
docker rm -f quarry-preview >/dev/null 2>&1
docker run --rm -d --name quarry-preview -e POSTGRES_PASSWORD=postgres -p 55432:5432 postgres:17
sleep 6
docker exec quarry-preview psql -U postgres -c "
  create schema analytics;
  create table users (id serial primary key, email text not null, tags text[]);
  create table \"Order\" (id serial primary key, total numeric);
  create table analytics.events (user_id int, seq int, primary key (user_id, seq));
  insert into users (email, tags) values ('a@b.co', array['vip']);
  insert into \"Order\" (total) values (12.34);
"
```

- [ ] **Step 2: Run the app**

```bash
cd /Users/lepetitdev/dev/quarry && npm run tauri dev
```

- [ ] **Step 3: Check each behavior**

- [ ] Double-clicking `users` opens an italic tab labelled `users` with results already shown
- [ ] Double-clicking `analytics.events` REPLACES that tab rather than adding one
- [ ] `"Order"` previews correctly — proving the identifier quoting works
- [ ] Typing in a preview tab drops the italic; double-clicking another table now opens a SECOND tab, leaving the edited one intact
- [ ] ⌘S on an edited preview offers to name it, as with any untitled tab
- [ ] Saved query tabs are untouched by all of this
- [ ] Quit and reopen: preview tabs are gone, saved and edited tabs are still there
- [ ] Your pre-existing saved queries and tabs survived the migration
- [ ] Result rows are numbered from 1, the numbers stay correct while scrolling a large result, and the gutter reads as dimmer than the data

- [ ] **Step 4: Tear down**

```bash
docker stop quarry-preview
```

- [ ] **Step 5: Full suite and tag**

```bash
cd /Users/lepetitdev/dev/quarry
npm test && npx tsc --noEmit && cd src-tauri && cargo test 2>&1 | grep -E "^test result"
cd /Users/lepetitdev/dev/quarry && git tag preview-tabs
```

---

## Definition of done

- Double-clicking a table opens a transient preview tab, already run
- One preview slot: a second preview replaces the first
- Editing a preview promotes it, and the next preview opens elsewhere
- Preview tabs are italic and labelled with the table name
- Previews never survive a restart; ordinary tabs always do
- Identifiers are quoted, so mixed-case and reserved-word tables work
- Existing databases migrate without losing tabs or queries
- Result rows carry an ordinal gutter that survives scrolling
- All tests pass: 127 Rust (119 + 2 migration + 6 store), 51 TS

## Deliberately not in this stage

Previewing a view (views are not in the tree yet), a row-count badge, choosing
the limit per preview, and pinning a preview without editing it. Still in
`docs/BACKLOG.md`: views in the tree, insert-name-at-cursor, copy DDL, and
moving queries between collections.
