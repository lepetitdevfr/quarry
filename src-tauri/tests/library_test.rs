use quarry_lib::library::model::{TabPin, TableMode};
use quarry_lib::library::store::Store;

/// Each test gets its own database in a temp dir, so tests never share
/// state and can run in parallel.
fn store() -> (Store, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open_at(&dir.path().join("test.db")).expect("store should open");
    (store, dir)
}

#[test]
fn creates_and_lists_a_collection() {
    let (s, _dir) = store();

    let c = s.create_collection("Billing", None).unwrap();
    assert_eq!(c.name, "Billing");
    assert_eq!(c.parent_id, None);

    let tree = s.tree().unwrap();
    assert_eq!(tree.collections.len(), 1);
    assert_eq!(tree.collections[0].id, c.id);
}

#[test]
fn nests_collections() {
    let (s, _dir) = store();

    let parent = s.create_collection("Billing", None).unwrap();
    let child = s.create_collection("Monthly", Some(&parent.id)).unwrap();

    assert_eq!(child.parent_id.as_deref(), Some(parent.id.as_str()));
    assert_eq!(s.tree().unwrap().collections.len(), 2);
}

#[test]
fn creates_a_query_inside_a_collection() {
    let (s, _dir) = store();

    let c = s.create_collection("Billing", None).unwrap();
    let q = s.create_query("mrr", "select 1", Some(&c.id)).unwrap();

    assert_eq!(q.name, "mrr");
    assert_eq!(q.sql, "select 1");
    assert_eq!(q.draft_sql, None);
    assert_eq!(q.collection_id.as_deref(), Some(c.id.as_str()));
}

#[test]
fn positions_siblings_with_a_gap() {
    let (s, _dir) = store();

    let a = s.create_collection("A", None).unwrap();
    let b = s.create_collection("B", None).unwrap();

    assert!(
        b.position > a.position,
        "later siblings sort after earlier ones"
    );
    assert_eq!(b.position - a.position, 100);
}

#[test]
fn renames_a_query() {
    let (s, _dir) = store();

    let q = s.create_query("old", "select 1", None).unwrap();
    s.rename_query(&q.id, "new").unwrap();

    let found = s.query(&q.id).unwrap().expect("query should exist");
    assert_eq!(found.name, "new");
}

#[test]
fn saving_clears_the_draft() {
    let (s, _dir) = store();

    let q = s.create_query("q", "select 1", None).unwrap();
    s.save_draft(&q.id, "select 2").unwrap();

    let drafted = s.query(&q.id).unwrap().unwrap();
    assert_eq!(drafted.draft_sql.as_deref(), Some("select 2"));
    assert_eq!(
        drafted.sql, "select 1",
        "draft must not overwrite saved text"
    );
    assert!(drafted.is_dirty());
    assert_eq!(drafted.effective_sql(), "select 2");

    s.save_query(&q.id, "select 2").unwrap();

    let saved = s.query(&q.id).unwrap().unwrap();
    assert_eq!(saved.sql, "select 2");
    assert_eq!(saved.draft_sql, None, "saving clears the draft");
    assert!(!saved.is_dirty());
}

#[test]
fn a_draft_survives_reopening_the_database() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("test.db");

    let id = {
        let s = Store::open_at(&path).unwrap();
        let q = s.create_query("q", "select 1", None).unwrap();
        s.save_draft(&q.id, "select 999").unwrap();
        q.id
    };

    // This is the whole point of the feature: quit mid-edit, come back,
    // find your typing intact.
    let reopened = Store::open_at(&path).unwrap();
    let q = reopened.query(&id).unwrap().unwrap();
    assert_eq!(q.effective_sql(), "select 999");
}

#[test]
fn moves_a_query_to_another_collection() {
    let (s, _dir) = store();

    let a = s.create_collection("A", None).unwrap();
    let b = s.create_collection("B", None).unwrap();
    let q = s.create_query("q", "select 1", Some(&a.id)).unwrap();

    s.move_query(&q.id, Some(&b.id)).unwrap();

    let moved = s.query(&q.id).unwrap().unwrap();
    assert_eq!(moved.collection_id.as_deref(), Some(b.id.as_str()));
}

#[test]
fn deletes_a_query() {
    let (s, _dir) = store();

    let q = s.create_query("q", "select 1", None).unwrap();
    s.delete_query(&q.id).unwrap();

    assert!(s.query(&q.id).unwrap().is_none());
    assert_eq!(s.tree().unwrap().queries.len(), 0);
}

#[test]
fn deleting_a_collection_removes_its_queries() {
    let (s, _dir) = store();

    let c = s.create_collection("Billing", None).unwrap();
    s.create_query("a", "select 1", Some(&c.id)).unwrap();
    s.create_query("b", "select 2", Some(&c.id)).unwrap();

    s.delete_collection(&c.id).unwrap();

    let tree = s.tree().unwrap();
    assert_eq!(tree.collections.len(), 0);
    assert_eq!(
        tree.queries.len(),
        0,
        "queries must not outlive their collection"
    );
}

#[test]
fn rejects_an_empty_name() {
    let (s, _dir) = store();

    assert!(s.create_collection("", None).is_err());
    assert!(s.create_query("", "select 1", None).is_err());
    assert!(s.create_query("   ", "select 1", None).is_err());
}

#[test]
fn opens_a_tab_for_a_query_and_makes_it_active() {
    let (s, _dir) = store();

    let q = s.create_query("q", "select 1", None).unwrap();
    let tab = s.open_tab(Some(&q.id)).unwrap();

    assert_eq!(tab.query_id.as_deref(), Some(q.id.as_str()));
    assert!(tab.is_active, "a newly opened tab takes focus");

    let tabs = s.tabs().unwrap();
    assert_eq!(tabs.len(), 1);
}

#[test]
fn only_one_tab_is_active_at_a_time() {
    let (s, _dir) = store();

    let a = s.create_query("a", "select 1", None).unwrap();
    let b = s.create_query("b", "select 2", None).unwrap();

    s.open_tab(Some(&a.id)).unwrap();
    let second = s.open_tab(Some(&b.id)).unwrap();

    let active: Vec<_> = s
        .tabs()
        .unwrap()
        .into_iter()
        .filter(|t| t.is_active)
        .collect();
    assert_eq!(active.len(), 1, "exactly one active tab");
    assert_eq!(active[0].id, second.id);
}

#[test]
fn opening_an_already_open_query_focuses_the_existing_tab() {
    let (s, _dir) = store();

    let q = s.create_query("q", "select 1", None).unwrap();
    let first = s.open_tab(Some(&q.id)).unwrap();
    let again = s.open_tab(Some(&q.id)).unwrap();

    assert_eq!(first.id, again.id, "no duplicate tab for the same query");
    assert_eq!(s.tabs().unwrap().len(), 1);
}

#[test]
fn opens_an_untitled_tab_with_scratch_text() {
    let (s, _dir) = store();

    let tab = s.open_tab(None).unwrap();
    assert_eq!(tab.query_id, None);

    s.save_scratch(&tab.id, "select 42").unwrap();

    let reloaded = s.tabs().unwrap();
    assert_eq!(reloaded[0].scratch_sql.as_deref(), Some("select 42"));
}

#[test]
fn tabs_survive_reopening_the_database() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("test.db");

    let (query_id, tab_id) = {
        let s = Store::open_at(&path).unwrap();
        let q = s.create_query("q", "select 1", None).unwrap();
        let t = s.open_tab(Some(&q.id)).unwrap();
        s.set_cursor(&t.id, 7).unwrap();
        (q.id, t.id)
    };

    let reopened = Store::open_at(&path).unwrap();
    let tabs = reopened.tabs().unwrap();

    assert_eq!(tabs.len(), 1);
    assert_eq!(tabs[0].id, tab_id);
    assert_eq!(tabs[0].query_id.as_deref(), Some(query_id.as_str()));
    assert_eq!(tabs[0].cursor_pos, 7, "cursor position is restored too");
}

#[test]
fn closing_a_tab_leaves_the_query_intact() {
    let (s, _dir) = store();

    let q = s.create_query("q", "select 1", None).unwrap();
    let t = s.open_tab(Some(&q.id)).unwrap();

    s.close_tab(&t.id, None).unwrap();

    assert_eq!(s.tabs().unwrap().len(), 0);
    assert!(
        s.query(&q.id).unwrap().is_some(),
        "closing a tab must not delete the query"
    );
}

#[test]
fn closing_the_active_middle_tab_activates_its_left_neighbour() {
    let (s, _dir) = store();

    let a = s.create_query("a", "select 1", None).unwrap();
    let b = s.create_query("b", "select 2", None).unwrap();
    let c = s.create_query("c", "select 3", None).unwrap();

    let ta = s.open_tab(Some(&a.id)).unwrap();
    let tb = s.open_tab(Some(&b.id)).unwrap();
    s.open_tab(Some(&c.id)).unwrap();
    // Make b the active tab (the middle one).
    s.activate_tab(&tb.id).unwrap();

    s.close_tab(&tb.id, None).unwrap();

    let remaining = s.tabs().unwrap();
    assert_eq!(remaining.len(), 2);
    let active: Vec<_> = remaining.iter().filter(|t| t.is_active).collect();
    assert_eq!(active.len(), 1, "exactly one active tab remains");
    assert_eq!(active[0].id, ta.id, "left neighbour becomes active");
}

#[test]
fn closing_the_active_leftmost_tab_activates_the_new_leftmost() {
    let (s, _dir) = store();

    let a = s.create_query("a", "select 1", None).unwrap();
    let b = s.create_query("b", "select 2", None).unwrap();

    let ta = s.open_tab(Some(&a.id)).unwrap();
    let tb = s.open_tab(Some(&b.id)).unwrap();
    s.activate_tab(&ta.id).unwrap();

    s.close_tab(&ta.id, None).unwrap();

    let remaining = s.tabs().unwrap();
    assert_eq!(remaining.len(), 1);
    assert!(
        remaining[0].is_active,
        "the only remaining tab becomes active"
    );
    assert_eq!(remaining[0].id, tb.id);
}

#[test]
fn closing_a_non_active_tab_does_not_change_which_tab_is_active() {
    let (s, _dir) = store();

    let a = s.create_query("a", "select 1", None).unwrap();
    let b = s.create_query("b", "select 2", None).unwrap();

    let ta = s.open_tab(Some(&a.id)).unwrap();
    let tb = s.open_tab(Some(&b.id)).unwrap();
    // tb is active (last opened).

    s.close_tab(&ta.id, None).unwrap();

    let remaining = s.tabs().unwrap();
    assert_eq!(remaining.len(), 1);
    assert_eq!(remaining[0].id, tb.id);
    assert!(remaining[0].is_active);
}

#[test]
fn closing_the_last_remaining_tab_leaves_no_tabs() {
    let (s, _dir) = store();

    let a = s.create_query("a", "select 1", None).unwrap();
    let ta = s.open_tab(Some(&a.id)).unwrap();

    s.close_tab(&ta.id, None).unwrap();

    assert_eq!(s.tabs().unwrap().len(), 0);
}

#[test]
fn deleting_a_query_closes_its_tab() {
    let (s, _dir) = store();

    let q = s.create_query("q", "select 1", None).unwrap();
    s.open_tab(Some(&q.id)).unwrap();

    s.delete_query(&q.id).unwrap();

    assert_eq!(
        s.tabs().unwrap().len(),
        0,
        "a tab pointing at nothing would crash the UI"
    );
}

#[test]
fn saving_a_query_writes_its_mirror_file() {
    let dir = tempfile::tempdir().unwrap();
    let mirror = dir.path().join("queries");
    let s = Store::open_at_with_mirror(&dir.path().join("test.db"), &mirror).unwrap();

    let c = s.create_collection("Billing", None).unwrap();
    let q = s.create_query("mrr", "select 1", Some(&c.id)).unwrap();
    s.save_query(&q.id, "select 2").unwrap();

    let file = mirror.join("Billing").join("mrr.sql");
    assert!(file.exists(), "expected {file:?}");
    assert_eq!(std::fs::read_to_string(file).unwrap(), "select 2");
}

#[test]
fn deleting_a_query_removes_its_mirror_file() {
    let dir = tempfile::tempdir().unwrap();
    let mirror = dir.path().join("queries");
    let s = Store::open_at_with_mirror(&dir.path().join("test.db"), &mirror).unwrap();

    let q = s.create_query("scratch", "select 1", None).unwrap();
    s.save_query(&q.id, "select 1").unwrap();
    assert!(mirror.join("scratch.sql").exists());

    s.delete_query(&q.id).unwrap();
    assert!(!mirror.join("scratch.sql").exists());
}

#[test]
fn autosaving_a_draft_does_not_touch_the_mirror() {
    let dir = tempfile::tempdir().unwrap();
    let mirror = dir.path().join("queries");
    let s = Store::open_at_with_mirror(&dir.path().join("test.db"), &mirror).unwrap();

    let q = s.create_query("q", "select 1", None).unwrap();
    s.save_query(&q.id, "select 1").unwrap();
    s.save_draft(&q.id, "select 999").unwrap();

    // Drafts fire on every keystroke; writing a file that often would
    // thrash the disk and fill git with noise.
    let content = std::fs::read_to_string(mirror.join("q.sql")).unwrap();
    assert_eq!(content, "select 1", "only explicit saves reach the mirror");
}

#[test]
fn opens_a_preview_tab() {
    let (store, _dir) = store();

    let tabs = store
        .open_preview_tab("users", "select * from users limit 500")
        .unwrap();

    assert_eq!(tabs.len(), 1);
    assert!(tabs[0].is_preview);
    assert_eq!(tabs[0].title.as_deref(), Some("users"));
    assert_eq!(
        tabs[0].scratch_sql.as_deref(),
        Some("select * from users limit 500")
    );
    assert!(tabs[0].is_active, "a preview opens focused");
}

#[test]
fn a_second_preview_reuses_the_same_slot() {
    let (store, _dir) = store();

    store
        .open_preview_tab("users", "select * from users limit 500")
        .unwrap();
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

    let tabs = store
        .open_preview_tab("users", "select * from users")
        .unwrap();

    assert_eq!(tabs.len(), 2);
    assert_eq!(tabs.iter().filter(|t| !t.is_preview).count(), 1);
}

#[test]
fn promoting_clears_the_preview_flag() {
    let (store, _dir) = store();
    let tabs = store
        .open_preview_tab("users", "select * from users")
        .unwrap();
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
    let first = store
        .open_preview_tab("users", "select * from users")
        .unwrap();
    let id = first[0].id.clone();
    store.promote_tab(&id).unwrap();

    let tabs = store
        .open_preview_tab("events", "select * from events")
        .unwrap();

    assert_eq!(tabs.len(), 2, "the promoted tab survives");
    assert!(tabs.iter().any(|t| t.id == id && !t.is_preview));
    assert!(tabs
        .iter()
        .any(|t| t.is_preview && t.title.as_deref() == Some("events")));
}

#[test]
fn preview_tabs_do_not_survive_reopening() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("w.db");

    {
        let store = Store::open_at(&path).unwrap();
        store
            .open_preview_tab("users", "select * from users")
            .unwrap();
        assert_eq!(store.tabs().unwrap().len(), 1);
    }

    let store = Store::open_at(&path).unwrap();
    assert!(store.tabs().unwrap().is_empty(), "previews are transient");
}

#[test]
fn an_ordinary_tab_targets_no_table() {
    let (s, _dir) = store();

    let tab = s.open_tab(None).unwrap();

    assert_eq!(tab.target_schema, None);
    assert_eq!(tab.target_table, None);
    assert_eq!(tab.mode, None);
}

#[test]
fn opens_a_table_tab_in_the_preview_slot() {
    let (s, _dir) = store();

    let tabs = s
        .open_table_tab("public", "users", TableMode::Structure, TabPin::Preview)
        .unwrap();

    assert_eq!(tabs.len(), 1);
    let tab = &tabs[0];
    assert_eq!(tab.target_schema.as_deref(), Some("public"));
    assert_eq!(tab.target_table.as_deref(), Some("users"));
    assert_eq!(tab.mode, Some(TableMode::Structure));
    assert_eq!(
        tab.title.as_deref(),
        Some("users"),
        "the tab is labelled by its table"
    );
    assert_eq!(tab.query_id, None);
    assert_eq!(tab.scratch_sql, None, "a table tab stores no SQL");
    assert!(tab.is_preview, "an unpinned table tab is a preview");
    assert!(tab.is_active);
}

#[test]
fn a_second_table_tab_reuses_the_preview_slot() {
    // Clicking down a long tree must not leave a tab per row.
    let (s, _dir) = store();

    s.open_table_tab("public", "users", TableMode::Structure, TabPin::Preview)
        .unwrap();
    let tabs = s
        .open_table_tab("public", "events", TableMode::Structure, TabPin::Preview)
        .unwrap();

    assert_eq!(tabs.len(), 1, "the preview slot is reused, not added to");
    assert_eq!(tabs[0].target_table.as_deref(), Some("events"));
}

#[test]
fn a_pinned_table_tab_is_not_reused() {
    let (s, _dir) = store();

    s.open_table_tab("public", "users", TableMode::Data, TabPin::Pinned)
        .unwrap();
    let tabs = s
        .open_table_tab("public", "events", TableMode::Structure, TabPin::Preview)
        .unwrap();

    assert_eq!(tabs.len(), 2, "the pinned tab survives");
    let pinned = tabs
        .iter()
        .find(|t| t.target_table.as_deref() == Some("users"))
        .unwrap();
    assert!(!pinned.is_preview);
    assert_eq!(pinned.mode, Some(TableMode::Data));
}

#[test]
fn a_query_preview_clears_a_table_target() {
    // One preview slot serves both kinds. Reusing it must not leave the
    // previous kind's fields behind, or a query preview would still
    // look like a table tab to the UI.
    let (s, _dir) = store();

    s.open_table_tab("public", "users", TableMode::Structure, TabPin::Preview)
        .unwrap();
    let tabs = s
        .open_preview_tab("events", "select * from events")
        .unwrap();

    assert_eq!(tabs.len(), 1);
    assert_eq!(tabs[0].target_schema, None);
    assert_eq!(tabs[0].target_table, None);
    assert_eq!(tabs[0].mode, None);
    assert_eq!(tabs[0].scratch_sql.as_deref(), Some("select * from events"));
}

#[test]
fn a_table_tab_clears_the_query_preview_it_replaces() {
    // The one preview slot serves both kinds, so taking it over must
    // drop the SQL the query preview left behind.
    let (s, _dir) = store();
    s.open_preview_tab("events", "select * from events")
        .unwrap();
    let tabs = s
        .open_table_tab("public", "users", TableMode::Structure, TabPin::Preview)
        .unwrap();

    assert_eq!(tabs.len(), 1, "the slot is reused, not added to");
    assert_eq!(
        tabs[0].scratch_sql, None,
        "the previous preview's SQL is gone"
    );
    assert_eq!(tabs[0].query_id, None);
    assert_eq!(tabs[0].target_table.as_deref(), Some("users"));
}

#[test]
fn double_clicking_pins_the_tab_that_was_a_preview() {
    // Single-click then double-click: the pin has to stick even though
    // the row already existed as a preview.
    let (s, _dir) = store();
    s.open_table_tab("public", "users", TableMode::Structure, TabPin::Preview)
        .unwrap();
    let tabs = s
        .open_table_tab("sales", "orders", TableMode::Data, TabPin::Pinned)
        .unwrap();

    assert_eq!(tabs.len(), 1, "the preview slot is taken over");
    assert!(!tabs[0].is_preview, "a double-click pins the reused row");
    assert_eq!(tabs[0].mode, Some(TableMode::Data));
    // Distinct words, so a swapped schema/table on the reuse path — a
    // different statement from the insert path — cannot pass unnoticed.
    assert_eq!(tabs[0].target_schema.as_deref(), Some("sales"));
    assert_eq!(tabs[0].target_table.as_deref(), Some("orders"));
    assert_eq!(tabs[0].title.as_deref(), Some("orders"));
}

#[test]
fn a_table_tab_round_trips_its_schema_and_table() {
    // The schema and the table are deliberately different words here.
    // Both columns are nullable text, so swapping them on the write or
    // the read path compiles and runs without complaint — only values
    // that can be told apart catch it.
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("test.db");

    {
        let s = Store::open_at(&path).unwrap();
        s.open_table_tab("sales", "orders", TableMode::Data, TabPin::Pinned)
            .unwrap();

        let tabs = s.tabs().unwrap();
        assert_eq!(tabs[0].target_schema.as_deref(), Some("sales"));
        assert_eq!(tabs[0].target_table.as_deref(), Some("orders"));
        assert_eq!(
            tabs[0].title.as_deref(),
            Some("orders"),
            "the label is the table, not the schema",
        );
    }

    // A pinned tab outlives a restart, so the same check has to hold
    // after the row has been through storage and back.
    let reopened = Store::open_at(&path).unwrap();
    let tabs = reopened.tabs().unwrap();
    assert_eq!(tabs.len(), 1);
    assert_eq!(tabs[0].target_schema.as_deref(), Some("sales"));
    assert_eq!(tabs[0].target_table.as_deref(), Some("orders"));
    assert_eq!(tabs[0].mode, Some(TableMode::Data));
}

#[test]
fn a_tab_with_a_target_but_no_stored_mode_reads_as_structure() {
    // `Tab` documents that a tab with a target always has a mode, and
    // the UI relies on it to decide what to render. Nothing stops a row
    // from having a target and a NULL mode — a hand-edited database, or
    // a future write path that forgets — so the decode fills the gap
    // with Structure, the face that runs no SQL against the server.
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("test.db");

    {
        let s = Store::open_at(&path).unwrap();
        // Pinned, so it survives the reopen below.
        s.open_table_tab("sales", "orders", TableMode::Data, TabPin::Pinned)
            .unwrap();
    }

    // Blank the mode behind the store's back — this state is not
    // reachable through the API, which is the point of testing it.
    rusqlite::Connection::open(&path)
        .unwrap()
        .execute("update tabs set mode = null", [])
        .unwrap();

    let tabs = Store::open_at(&path).unwrap().tabs().unwrap();
    assert_eq!(tabs[0].target_table.as_deref(), Some("orders"));
    assert_eq!(tabs[0].mode, Some(TableMode::Structure));
}

#[test]
fn switching_mode_pins_the_tab() {
    // Toggling to Data is a deliberate act on a specific table, so the
    // tab stops being disposable — same rule as editing a query preview.
    let (s, _dir) = store();

    let tabs = s
        .open_table_tab("public", "users", TableMode::Structure, TabPin::Preview)
        .unwrap();
    let id = tabs[0].id.clone();

    let tabs = s.set_tab_mode(&id, TableMode::Data).unwrap();

    assert_eq!(tabs[0].mode, Some(TableMode::Data));
    assert!(!tabs[0].is_preview, "switching mode pins the tab");
}

// ---- record tabs -------------------------------------------------------
//
// History and Writes outgrew the sidebar: a statement is a line of SQL
// and the sidebar is 250px wide, so the two lists that exist to be read
// were the ones that could not be. They open as tabs in the main area
// instead.

#[test]
fn opening_a_record_shows_it_in_a_tab() {
    let (s, _dir) = store();

    let tabs = s.open_record_tab("history").unwrap();

    let tab = tabs.iter().find(|t| t.record.as_deref() == Some("history"));
    let tab = tab.expect("a history tab should exist");
    assert!(tab.is_active);
    assert_eq!(tab.query_id, None, "a record tab holds no query");
    assert_eq!(tab.target_table, None, "and no table");
}

#[test]
fn opening_the_same_record_twice_focuses_the_one_tab() {
    // Two copies of one list is two places to look.
    let (s, _dir) = store();

    s.open_record_tab("writes").unwrap();
    let tabs = s.open_record_tab("writes").unwrap();

    assert_eq!(
        tabs.iter()
            .filter(|t| t.record.as_deref() == Some("writes"))
            .count(),
        1
    );
}

#[test]
fn the_two_records_are_two_different_tabs() {
    let (s, _dir) = store();

    s.open_record_tab("history").unwrap();
    let tabs = s.open_record_tab("writes").unwrap();

    assert_eq!(tabs.iter().filter(|t| t.record.is_some()).count(), 2);
    assert!(
        tabs.iter()
            .find(|t| t.record.as_deref() == Some("writes"))
            .unwrap()
            .is_active,
        "the one just opened takes focus"
    );
}

#[test]
fn a_record_tab_survives_a_restart() {
    // It is an ordinary tab in every other respect, including being
    // restored — closing it is how you get rid of it.
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("w.db");
    {
        let s = Store::open_at(&path).unwrap();
        s.open_record_tab("history").unwrap();
    }

    let s = Store::open_at(&path).unwrap();

    assert_eq!(
        s.tabs()
            .unwrap()
            .iter()
            .filter(|t| t.record.as_deref() == Some("history"))
            .count(),
        1
    );
}
