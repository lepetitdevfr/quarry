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

    assert!(b.position > a.position, "later siblings sort after earlier ones");
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
    assert_eq!(drafted.sql, "select 1", "draft must not overwrite saved text");
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
    assert_eq!(tree.queries.len(), 0, "queries must not outlive their collection");
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

    let active: Vec<_> = s.tabs().unwrap().into_iter().filter(|t| t.is_active).collect();
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

    s.close_tab(&t.id).unwrap();

    assert_eq!(s.tabs().unwrap().len(), 0);
    assert!(s.query(&q.id).unwrap().is_some(), "closing a tab must not delete the query");
}

#[test]
fn deleting_a_query_closes_its_tab() {
    let (s, _dir) = store();

    let q = s.create_query("q", "select 1", None).unwrap();
    s.open_tab(Some(&q.id)).unwrap();

    s.delete_query(&q.id).unwrap();

    assert_eq!(s.tabs().unwrap().len(), 0, "a tab pointing at nothing would crash the UI");
}
