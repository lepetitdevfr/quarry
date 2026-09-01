//! What to do about a write that is already allowed to run.
//!
//! Pure: tag, kind, rowcount and declared expectation in — verdict out.
//! No pool and no clock, the same shape as `guard::decide` and
//! `edit::decide`, and for the same reason: the rule table is small
//! enough to test exhaustively, and every rule in it is load-bearing.
//!
//! This runs *after* `guard::decide`, never instead of it. A write on a
//! locked production connection is denied before anything here is
//! reached; the unlock ritual is unchanged.

use crate::library::model::Tag;

/// How many rows a write may touch on a non-production connection
/// before it stops to ask.
///
/// A constant rather than a setting: defaults are the product, and a
/// threshold somebody tuned once and forgot is a guard that does not
/// guard.
pub const ASK_ABOVE_ROWS: u64 = 100;

/// What kind of write this is, from the parse `classify` already does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriteKind {
    Update,
    Delete,
    Insert,
    /// `DROP`, `TRUNCATE`, `ALTER`, `CREATE` — no rowcount, and the
    /// statements that end careers.
    Ddl,
    /// Anything else, including statements the parser cannot read.
    Other,
}

/// What happens to a write that has already run inside an open
/// transaction.
#[derive(Debug)]
pub enum Verdict {
    Commit,
    Ask { summary: String },
    Refuse { reason: String },
}

/// The `-- expect: n` a statement declares, if it declares one.
///
/// The last one wins: people edit the number in place and leave the old
/// line above it. Anything that is not a plain number is ignored rather
/// than guessed at — a typo in a comment must neither disarm the guard
/// nor invent an expectation the user never stated.
pub fn expected_rows(sql: &str) -> Option<u64> {
    let lowered = sql.to_lowercase();
    let mut found = None;

    for line in lowered.split('\n') {
        let Some(at) = line.find("--") else { continue };
        let comment = line[at + 2..].trim();
        let Some(value) = comment.strip_prefix("expect:") else {
            continue;
        };
        if let Ok(n) = value.trim().parse::<u64>() {
            found = Some(n);
        }
    }

    found
}

/// Decide what happens to a write that has run and reported its
/// rowcount.
///
/// The order is the point:
///
/// 1. A declared expectation reality contradicts is a failed assertion,
///    not a decision — it refuses, whatever the connection.
/// 2. Production asks. Always, including for one row and including when
///    an expectation matched: a rule with an exception is a rule you
///    have to remember the exception to.
/// 3. DDL asks, described by what it names, having no rowcount to be
///    judged on.
/// 4. A matching expectation commits.
/// 5. A large rowcount asks.
/// 6. Everything else commits.
pub fn verdict(
    tag: Tag,
    kind: WriteKind,
    affected: Option<u64>,
    expect: Option<u64>,
    object: Option<&str>,
) -> Verdict {
    if let (Some(expected), Some(actual)) = (expect, affected) {
        if expected != actual {
            return Verdict::Refuse {
                reason: format!(
                    "-- expect: {expected}, but {actual} {} matched — rolled back",
                    if actual == 1 { "row" } else { "rows" }
                ),
            };
        }
    }

    if tag == Tag::Prod {
        return Verdict::Ask {
            summary: summary_for(kind, affected, object),
        };
    }

    if kind == WriteKind::Ddl {
        return Verdict::Ask {
            summary: summary_for(kind, affected, object),
        };
    }

    if expect.is_some() {
        return Verdict::Commit;
    }

    match affected {
        Some(n) if n > ASK_ABOVE_ROWS => Verdict::Ask {
            summary: summary_for(kind, affected, object),
        },
        _ => Verdict::Commit,
    }
}

/// Whether a committed write of this kind leaves the cached schema
/// describing a database that no longer exists.
///
/// A `match` rather than `kind == Ddl` so a kind added later has to
/// answer the question: a new DDL form that fell through to `false`
/// would leave the tree listing a dropped table, and the failure is
/// silent.
pub fn changes_structure(kind: WriteKind) -> bool {
    match kind {
        WriteKind::Ddl => true,
        // `Other` covers what the parser could not read, which is a
        // real possibility for exotic DDL. Refreshing on every one of
        // those would walk the catalog after statements that never
        // touch it, so the miss is accepted and the refresh button is
        // the escape hatch.
        WriteKind::Update | WriteKind::Delete | WriteKind::Insert | WriteKind::Other => false,
    }
}

/// The one sentence the confirmation leads with.
fn summary_for(kind: WriteKind, affected: Option<u64>, object: Option<&str>) -> String {
    if kind == WriteKind::Ddl {
        return match object {
            Some(what) => format!("this changes {what}"),
            None => "this changes the database's structure".to_string(),
        };
    }

    match affected {
        Some(1) => "1 row will change".to_string(),
        Some(n) => format!("{n} rows will change"),
        None => "this will change the database".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::model::Tag;

    #[test]
    fn a_small_local_write_commits_without_asking() {
        assert!(matches!(
            verdict(Tag::Local, WriteKind::Update, Some(3), None, None),
            Verdict::Commit
        ));
    }

    #[test]
    fn production_always_asks() {
        // No exceptions, including one row and including a matching
        // `expect`: a rule with an exception is a rule you have to
        // remember the exception to.
        assert!(matches!(
            verdict(Tag::Prod, WriteKind::Update, Some(1), None, None),
            Verdict::Ask { .. }
        ));
        assert!(matches!(
            verdict(Tag::Prod, WriteKind::Update, Some(1), Some(1), None),
            Verdict::Ask { .. }
        ));
    }

    #[test]
    fn a_mismatched_expectation_refuses_and_names_both_numbers() {
        match verdict(Tag::Local, WriteKind::Update, Some(4812), Some(1), None) {
            Verdict::Refuse { reason } => {
                assert!(reason.contains('1'), "reason was: {reason}");
                assert!(reason.contains("4812"), "reason was: {reason}");
            }
            other => panic!("expected a refusal, got {other:?}"),
        }
    }

    #[test]
    fn a_matching_expectation_commits_off_production() {
        assert!(matches!(
            verdict(Tag::Staging, WriteKind::Update, Some(900), Some(900), None),
            Verdict::Commit
        ));
    }

    #[test]
    fn a_mismatch_outranks_everything_including_production() {
        // Refusing is not a decision to hand to a dialog: the user
        // stated a fact and the database disagreed.
        assert!(matches!(
            verdict(Tag::Prod, WriteKind::Update, Some(2), Some(1), None),
            Verdict::Refuse { .. }
        ));
    }

    #[test]
    fn a_large_write_asks_even_off_production() {
        assert!(matches!(
            verdict(
                Tag::Local,
                WriteKind::Delete,
                Some(ASK_ABOVE_ROWS + 1),
                None,
                None
            ),
            Verdict::Ask { .. }
        ));
        assert!(matches!(
            verdict(
                Tag::Local,
                WriteKind::Delete,
                Some(ASK_ABOVE_ROWS),
                None,
                None
            ),
            Verdict::Commit
        ));
    }

    #[test]
    fn ddl_always_asks_and_is_described_by_what_it_names() {
        // It reports no rows, so the rowcount rules say nothing about
        // it — and it is the statement that ends careers.
        match verdict(
            Tag::Local,
            WriteKind::Ddl,
            None,
            None,
            Some("public.orders, ~5M rows"),
        ) {
            Verdict::Ask { summary } => assert!(summary.contains("public.orders")),
            other => panic!("expected a question, got {other:?}"),
        }
    }

    #[test]
    fn ddl_with_nothing_known_about_it_still_asks() {
        assert!(matches!(
            verdict(Tag::Local, WriteKind::Ddl, None, None, None),
            Verdict::Ask { .. }
        ));
    }

    #[test]
    fn an_unreadable_statement_is_judged_on_its_rowcount_like_any_other() {
        // `classify` already calls anything it cannot parse a write.
        // Judging it on rows can only ask more often than necessary.
        assert!(matches!(
            verdict(Tag::Local, WriteKind::Other, Some(1), None, None),
            Verdict::Commit
        ));
        assert!(matches!(
            verdict(Tag::Local, WriteKind::Other, Some(5000), None, None),
            Verdict::Ask { .. }
        ));
    }

    #[test]
    fn the_summary_says_what_will_change() {
        match verdict(Tag::Prod, WriteKind::Delete, Some(4812), None, None) {
            Verdict::Ask { summary } => assert!(summary.contains("4812")),
            other => panic!("expected a question, got {other:?}"),
        }
    }

    #[test]
    fn an_expectation_is_read_out_of_a_comment() {
        assert_eq!(expected_rows("update t set a = 1 -- expect: 1"), Some(1));
        assert_eq!(expected_rows("-- expect: 42\nupdate t set a = 1"), Some(42));
        assert_eq!(expected_rows("update t set a = 1 --expect:7"), Some(7));
        assert_eq!(expected_rows("UPDATE t SET a = 1 -- EXPECT: 9"), Some(9));
    }

    #[test]
    fn the_last_expectation_wins() {
        // People edit the number in place and leave the old one above.
        assert_eq!(
            expected_rows("-- expect: 1\nupdate t set a = 1 -- expect: 2"),
            Some(2)
        );
    }

    #[test]
    fn a_malformed_expectation_is_ignored_rather_than_guessed() {
        // A typo in a comment must not silently disarm the guard, and
        // must not invent a number either: the ordinary rules apply.
        assert_eq!(expected_rows("update t set a = 1 -- expect: lots"), None);
        assert_eq!(expected_rows("update t set a = 1 -- expected: 3"), None);
        assert_eq!(expected_rows("update t set a = 1"), None);
    }

    #[test]
    fn only_ddl_invalidates_the_cached_schema() {
        assert!(changes_structure(WriteKind::Ddl));
        assert!(!changes_structure(WriteKind::Update));
        assert!(!changes_structure(WriteKind::Delete));
        assert!(!changes_structure(WriteKind::Insert));
        assert!(!changes_structure(WriteKind::Other));
    }
}
