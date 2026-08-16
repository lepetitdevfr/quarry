mod common;

use quarry_lib::schema::introspect;

/// A fixture exercising every shape the tree must render: a composite
/// primary key, a cross-schema foreign key, unique and partial indexes,
/// a check constraint, nullable and defaulted columns, an array column,
/// and an enum.
const FIXTURE: &str = "
    create schema analytics;

    create type mood as enum ('sad', 'ok', 'happy');

    create table public.users (
        id          serial primary key,
        email       text not null,
        nickname    text,
        plan        text not null default 'free',
        tags        text[],
        temperament mood
    );

    create unique index users_email_key on public.users (email);
    create index users_active_plan on public.users (plan) where nickname is not null;
    alter table public.users add constraint email_has_at check (email like '%@%');

    comment on table public.users is 'People who signed up.';

    create function public.touch_users() returns trigger as $$
      begin return new; end;
    $$ language plpgsql;

    create trigger users_touched before update on public.users
      for each row execute function public.touch_users();

    create view public.active_users as select id, email from public.users;
    create materialized view public.user_count as select count(*) from public.users;

    create table analytics.events (
        user_id    integer not null references public.users(id),
        seq        integer not null,
        payload    jsonb,
        primary key (user_id, seq)
    );
";

async fn fixture_schema() -> (quarry_lib::schema::Schema, common::TestDb) {
    let db = common::start().await;
    let client = db.pool.get().await.expect("checkout");
    client
        .batch_execute(FIXTURE)
        .await
        .expect("fixture should apply");
    let schema = introspect(&db.pool)
        .await
        .expect("introspection should succeed");
    (schema, db)
}

fn table<'a>(
    schema: &'a quarry_lib::schema::Schema,
    schema_name: &str,
    table_name: &str,
) -> &'a quarry_lib::schema::Table {
    schema
        .schemas
        .iter()
        .find(|s| s.name == schema_name)
        .unwrap_or_else(|| panic!("no schema {schema_name}"))
        .tables
        .iter()
        .find(|t| t.name == table_name)
        .unwrap_or_else(|| panic!("no table {table_name}"))
}

#[tokio::test]
async fn finds_user_schemas_and_hides_system_ones() {
    let (schema, _db) = fixture_schema().await;

    let names: Vec<&str> = schema.schemas.iter().map(|s| s.name.as_str()).collect();

    assert!(names.contains(&"public"));
    assert!(names.contains(&"analytics"));
    assert!(
        !names
            .iter()
            .any(|n| n.starts_with("pg_") || *n == "information_schema"),
        "system schemas must be filtered out, got {names:?}",
    );
}

#[tokio::test]
async fn reports_columns_in_ordinal_order_with_types() {
    let (schema, _db) = fixture_schema().await;
    let users = table(&schema, "public", "users");

    let names: Vec<&str> = users.columns.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(
        names,
        vec!["id", "email", "nickname", "plan", "tags", "temperament"],
        "columns must keep their declared order, not alphabetical",
    );

    let email = users.columns.iter().find(|c| c.name == "email").unwrap();
    assert_eq!(email.type_name, "text");
}

#[tokio::test]
async fn distinguishes_nullable_from_not_null() {
    let (schema, _db) = fixture_schema().await;
    let users = table(&schema, "public", "users");

    let email = users.columns.iter().find(|c| c.name == "email").unwrap();
    let nickname = users.columns.iter().find(|c| c.name == "nickname").unwrap();

    assert!(!email.nullable);
    assert!(nickname.nullable);
}

#[tokio::test]
async fn reports_defaults() {
    let (schema, _db) = fixture_schema().await;
    let users = table(&schema, "public", "users");

    let plan = users.columns.iter().find(|c| c.name == "plan").unwrap();
    assert!(
        plan.default.as_deref().unwrap_or_default().contains("free"),
        "expected the default expression, got {:?}",
        plan.default,
    );

    let nickname = users.columns.iter().find(|c| c.name == "nickname").unwrap();
    assert_eq!(nickname.default, None);
}

#[tokio::test]
async fn marks_primary_keys_including_composite_ones() {
    let (schema, _db) = fixture_schema().await;

    let users = table(&schema, "public", "users");
    let id = users.columns.iter().find(|c| c.name == "id").unwrap();
    assert!(id.is_primary_key);

    let events = table(&schema, "analytics", "events");
    let pk_columns: Vec<&str> = events
        .columns
        .iter()
        .filter(|c| c.is_primary_key)
        .map(|c| c.name.as_str())
        .collect();
    assert_eq!(
        pk_columns,
        vec!["user_id", "seq"],
        "both halves of a composite key"
    );
}

#[tokio::test]
async fn resolves_a_cross_schema_foreign_key() {
    let (schema, _db) = fixture_schema().await;
    let events = table(&schema, "analytics", "events");

    let user_id = events.columns.iter().find(|c| c.name == "user_id").unwrap();
    let fk = user_id
        .references
        .as_ref()
        .expect("user_id references users");

    assert_eq!(fk.schema, "public");
    assert_eq!(fk.table, "users");
    assert_eq!(fk.column, "id");
}

#[tokio::test]
async fn reports_indexes_with_their_definitions() {
    let (schema, _db) = fixture_schema().await;
    let users = table(&schema, "public", "users");

    let unique = users
        .indexes
        .iter()
        .find(|i| i.name == "users_email_key")
        .expect("unique index");
    assert!(unique.is_unique);
    assert!(!unique.is_primary);
    assert!(unique.definition.to_lowercase().contains("unique"));

    let partial = users
        .indexes
        .iter()
        .find(|i| i.name == "users_active_plan")
        .expect("partial index");
    assert!(
        partial.definition.to_lowercase().contains("where"),
        "a partial index must keep its predicate: {}",
        partial.definition,
    );

    assert!(
        users.indexes.iter().any(|i| i.is_primary),
        "the primary key's index should be listed too",
    );
}

#[tokio::test]
async fn reports_constraints_with_their_definitions() {
    let (schema, _db) = fixture_schema().await;
    let users = table(&schema, "public", "users");

    let check = users
        .constraints
        .iter()
        .find(|c| c.name == "email_has_at")
        .expect("check constraint");

    assert_eq!(check.kind, "c");

    // Postgres deparses the definition rather than echoing the source:
    // `LIKE` comes back as the `~~` operator, so asserting on the word
    // "like" would fail forever. What matters is that a real, complete
    // definition arrives — it starts with CHECK and names the column.
    let definition = check.definition.to_lowercase();
    assert!(
        definition.starts_with("check"),
        "expected a CHECK definition, got: {}",
        check.definition,
    );
    assert!(
        definition.contains("email"),
        "the definition should name the column it constrains, got: {}",
        check.definition,
    );

    // The primary key and the unique index also surface as constraints.
    assert!(
        users.constraints.iter().any(|c| c.kind == "p"),
        "primary key should appear as a constraint",
    );
}

#[tokio::test]
async fn reports_a_foreign_key_constraint_on_the_referencing_table() {
    let (schema, _db) = fixture_schema().await;
    let events = table(&schema, "analytics", "events");

    let fk = events
        .constraints
        .iter()
        .find(|c| c.kind == "f")
        .expect("events references users");

    assert!(
        fk.definition.to_lowercase().contains("references"),
        "got: {}",
        fk.definition,
    );
}

#[tokio::test]
async fn renders_array_and_enum_column_types_readably() {
    let (schema, _db) = fixture_schema().await;
    let users = table(&schema, "public", "users");

    let tags = users.columns.iter().find(|c| c.name == "tags").unwrap();
    assert_eq!(tags.type_name, "text[]", "not the internal _text spelling");

    let temperament = users
        .columns
        .iter()
        .find(|c| c.name == "temperament")
        .unwrap();
    assert_eq!(temperament.type_name, "mood");
}

#[tokio::test]
async fn an_empty_database_yields_empty_schemas_not_an_error() {
    let db = common::start().await;

    let schema = introspect(&db.pool).await.expect("should succeed");

    // `public` exists in a fresh database but holds no tables.
    let public = schema.schemas.iter().find(|s| s.name == "public");
    assert!(public.map(|s| s.tables.is_empty()).unwrap_or(true));
}

#[tokio::test]
async fn reports_size_row_estimate_and_comment() {
    let (schema, _db) = fixture_schema().await;
    let users = table(&schema, "public", "users");

    let stats = users.stats.as_ref().expect("stats should be read");
    // An empty, never-analyzed table reports -1 rather than 0. The
    // number is the planner's estimate, which is why the UI says
    // "estimated" — asserting a row count here would be asserting a
    // guess.
    assert!(stats.estimated_rows <= 0);
    // Even an empty table occupies pages once it has indexes.
    assert!(
        stats.total_bytes > 0,
        "total_bytes was {}",
        stats.total_bytes
    );
    assert_eq!(users.comment.as_deref(), Some("People who signed up."));

    // A table with no comment reports none rather than an empty string.
    assert_eq!(table(&schema, "analytics", "events").comment, None);
}

#[tokio::test]
async fn reports_user_triggers_but_not_internal_ones() {
    let (schema, _db) = fixture_schema().await;

    let users = table(&schema, "public", "users");
    assert_eq!(users.triggers.len(), 1);
    assert_eq!(users.triggers[0].name, "users_touched");
    // pg_get_triggerdef renders keywords uppercase.
    assert!(
        users.triggers[0]
            .definition
            .to_lowercase()
            .contains("before update"),
        "definition was: {}",
        users.triggers[0].definition
    );

    // `events` has a foreign key, which Postgres implements with
    // internal triggers. Listing those would imply the user wrote them.
    assert!(table(&schema, "analytics", "events").triggers.is_empty());
}

#[tokio::test]
async fn reports_the_views_that_read_a_table() {
    let (schema, _db) = fixture_schema().await;
    let users = table(&schema, "public", "users");

    let mut found: Vec<(String, String)> = users
        .dependents
        .iter()
        .map(|d| (d.name.clone(), d.kind.clone()))
        .collect();
    found.sort();

    assert_eq!(
        found,
        vec![
            ("active_users".to_string(), "v".to_string()),
            ("user_count".to_string(), "m".to_string()),
        ]
        .into_iter()
        .collect::<Vec<_>>()
        .tap_sorted()
    );
}

/// Sorting helper kept local: the assertion above compares two sorted
/// lists and inlining the sort twice reads worse than naming it.
trait TapSorted {
    fn tap_sorted(self) -> Self;
}

impl TapSorted for Vec<(String, String)> {
    fn tap_sorted(mut self) -> Self {
        self.sort();
        self
    }
}
