use quarry_lib::guard::{classify, Access};

/// Reads. Each of these must be runnable on a locked production
/// connection — that is the whole point of classifying rather than
/// blocking everything.
#[test]
fn plain_reads_are_reads() {
    for sql in [
        "select 1",
        "select * from users where id = 3",
        "select count(*) from orders group by status having count(*) > 2",
        // `TABLE users` (bare shorthand for `SELECT * FROM users`) is
        // omitted here: sqlparser 0.58 does not parse it as a top-level
        // statement under either the Postgres or generic dialect, so it
        // falls through the parse-failure arm to `Write` — the safe,
        // merely-annoying direction, not the dangerous one.
        "values (1), (2)",
        "show statement_timeout",
        "explain select * from users",
        "with recent as (select * from orders limit 10) select * from recent",
        "select * from a union select * from b",
    ] {
        assert_eq!(classify(sql), Access::Read, "should be a read: {sql}");
    }
}

/// Writes. A miss here runs a mutation on production.
#[test]
fn mutations_are_writes() {
    for sql in [
        "insert into users (id) values (1)",
        "update users set name = 'x'",
        "delete from users",
        "truncate users",
        "drop table users",
        "create table t (id int)",
        "alter table users add column x int",
        "create index on users (id)",
        "grant select on users to bob",
        "call do_something()",
        "do $$ begin end $$",
        "copy users from '/tmp/x.csv'",
    ] {
        assert_eq!(classify(sql), Access::Write, "should be a write: {sql}");
    }
}

/// The subtle ones. Each of these looks like a read at a glance and is
/// not — they are the reason this is a parser and not a keyword check.
#[test]
fn statements_that_look_like_reads_but_write() {
    for sql in [
        // Takes row locks.
        "select * from users for update",
        "select * from users for share",
        // Runs the statement it is explaining.
        "explain analyze select * from users",
        // A data-modifying CTE: the outer statement is a SELECT.
        "with moved as (delete from users returning *) select * from moved",
        "with added as (insert into users (id) values (1) returning *) select * from added",
        "with bumped as (update users set n = n + 1 returning *) select * from bumped",
        // `SELECT ... INTO` creates and populates a new table. It reads
        // like a plain SELECT but is a write.
        "select * into new_table from users",
    ] {
        assert_eq!(classify(sql), Access::Write, "should be a write: {sql}");
    }
}

#[test]
fn unparseable_sql_is_a_write() {
    // The spec's rule: what cannot be classified cannot be run on a
    // locked connection. Wrong in the safe direction.
    for sql in [
        "this is not sql",
        "select * from",
        "sel ect 1",
    ] {
        assert_eq!(classify(sql), Access::Write, "should be a write: {sql}");
    }
}

#[test]
fn empty_input_is_a_read() {
    // Nothing to run, so nothing to guard. Denying this would produce a
    // confusing error on an empty editor.
    assert_eq!(classify(""), Access::Read);
    assert_eq!(classify("   \n  "), Access::Read);
    assert_eq!(classify("-- just a comment"), Access::Read);
}

#[test]
fn a_buffer_is_a_write_if_any_statement_writes() {
    // The whole buffer is judged together: one write condemns it.
    assert_eq!(classify("select 1; select 2"), Access::Read);
    assert_eq!(classify("select 1; delete from users"), Access::Write);
    assert_eq!(classify("delete from users; select 1"), Access::Write);
}
