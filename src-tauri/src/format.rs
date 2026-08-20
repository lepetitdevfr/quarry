//! Laying a statement out so it can be read.
//!
//! Pure: text in, text out, no pool and no clock — the same shape as
//! `guard` and `edit::decide`, and for the same reason. Formatting
//! rewrites the user's buffer, so every rule about what it will and
//! will not touch is worth a test.

use crate::error::AppError;
use sqlformat::{Dialect, FormatOptions, Indent, QueryParams};

/// Text this formatter refuses to touch.
///
/// `sqlformat` treats a dollar-quoted body as SQL to lay out: it injects
/// newlines into it and re-cases words inside it. That is right often
/// enough for a plpgsql function body and wrong always for a string
/// literal, where it silently changes the value. There is no way to ask
/// it for one and not the other, so a statement containing any
/// dollar-quoting is returned untouched with a reason.
///
/// Deliberately conservative: it looks for the delimiter anywhere,
/// including inside ordinary quotes, so it declines a little more often
/// than it must. Declining to format costs a keystroke; mangling a
/// literal costs data.
fn dollar_quoted(sql: &str) -> bool {
    let bytes = sql.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'$' {
            // `$$`, or `$tag$` where tag is an identifier.
            let mut j = i + 1;
            while j < bytes.len() && (bytes[j].is_ascii_alphanumeric() || bytes[j] == b'_') {
                j += 1;
            }
            if j < bytes.len() && bytes[j] == b'$' {
                return true;
            }
        }
        i += 1;
    }
    false
}

/// Lay out one statement.
///
/// Keyword case is left exactly as typed. Upper-casing is what most
/// formatters do, but this app writes its own SQL in lower case — the
/// generated table preview, the copied `select` — and a Format button
/// that disagreed with the app's own voice would be the app arguing with
/// itself.
pub fn pretty(sql: &str) -> Result<String, AppError> {
    if sql.trim().is_empty() {
        return Err(AppError::Query {
            message: "nothing to format".to_string(),
            code: None,
            position: None,
        });
    }

    if dollar_quoted(sql) {
        return Err(AppError::Query {
            message: "left as it is: formatting would rewrite the text inside $$…$$".to_string(),
            code: None,
            position: None,
        });
    }

    Ok(sqlformat::format(
        sql,
        &QueryParams::None,
        &FormatOptions {
            indent: Indent::Spaces(2),
            // Left as typed. See the note above.
            uppercase: None,
            lines_between_queries: 1,
            dialect: Dialect::PostgreSql,
            ..Default::default()
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn done(sql: &str) -> String {
        pretty(sql).expect("should format")
    }

    fn refusal(sql: &str) -> String {
        match pretty(sql) {
            Err(AppError::Query { message, .. }) => message,
            other => panic!("expected a refusal, got {other:?}"),
        }
    }

    #[test]
    fn breaks_a_one_liner_onto_its_clauses() {
        let out = done("select id, email from users where plan = 'free' order by id limit 10");

        assert!(out.contains("select\n"), "got:\n{out}");
        assert!(out.contains("from\n"), "got:\n{out}");
        assert!(out.contains("where\n"), "got:\n{out}");
    }

    #[test]
    fn leaves_keyword_case_alone() {
        // The app writes its own SQL in lower case; a Format button that
        // shouted would be the app disagreeing with itself.
        assert!(done("select 1").starts_with("select"));
        assert!(done("SELECT 1").starts_with("SELECT"));
    }

    #[test]
    fn formatting_twice_changes_nothing_the_second_time() {
        // A button whose output moves every time you press it teaches
        // people not to press it.
        let once = done("select a, b from t where a = 1");
        assert_eq!(done(&once), once);
    }

    #[test]
    fn a_string_literal_survives_untouched() {
        let out = done("select 'it''s a select from where' as s");

        assert!(
            out.contains("'it''s a select from where'"),
            "the literal must be byte-identical, got:\n{out}"
        );
    }

    #[test]
    fn comments_survive() {
        let out = done("-- why this exists\nselect 1");
        assert!(out.contains("-- why this exists"), "got:\n{out}");
    }

    #[test]
    fn dollar_quoted_text_is_refused_rather_than_rewritten() {
        // The hazard this rule exists for: `sqlformat` lays out what is
        // between the delimiters, which for a literal means changing the
        // value the query carries.
        let reason = refusal("select $$ a select from where inside a literal $$ as s");
        assert!(reason.contains("$$"), "reason was: {reason}");

        assert!(pretty("select $tag$ keep this $tag$ as s").is_err());
        assert!(pretty(
            "create function f() returns trigger as $$ begin return new; end; $$ language plpgsql"
        )
        .is_err());
    }

    #[test]
    fn an_ordinary_dollar_sign_is_not_dollar_quoting() {
        // A parameter placeholder or a lone `$` must not cost the user
        // the feature.
        assert!(pretty("select * from t where id = 1 -- costs $5").is_ok());
        assert!(pretty("select '$' as sigil").is_ok());
    }

    #[test]
    fn an_empty_buffer_says_so_rather_than_returning_nothing() {
        assert_eq!(refusal("   \n  "), "nothing to format");
    }
}
