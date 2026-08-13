//! The `.sql` mirror is WRITE-ONLY output.
//!
//! Saved queries are also written to plain `.sql` files so the library
//! is greppable and can be committed to git. Nothing in the app ever
//! reads these files back — the SQLite database is the single source
//! of truth. Editing a file on disk will NOT change the library, and
//! the next save overwrites it.

use crate::error::AppError;
use std::path::{Path, PathBuf};

/// Write one query to `<root>/<collection path>/<name>.sql`.
pub fn write_query(
    root: &Path,
    collection_path: &[&str],
    name: &str,
    sql: &str,
) -> Result<(), AppError> {
    let dir = resolve_dir(root, collection_path);
    std::fs::create_dir_all(&dir).map_err(io_err)?;

    let file = dir.join(format!("{}.sql", sanitise(name)));
    std::fs::write(file, sql).map_err(io_err)?;
    Ok(())
}

/// Remove a query's file. A missing file is success — the end state
/// the caller wants already holds.
pub fn remove_query(root: &Path, collection_path: &[&str], name: &str) -> Result<(), AppError> {
    let file = resolve_dir(root, collection_path).join(format!("{}.sql", sanitise(name)));
    match std::fs::remove_file(file) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(io_err(e)),
    }
}

fn resolve_dir(root: &Path, collection_path: &[&str]) -> PathBuf {
    let mut dir = root.to_path_buf();
    for segment in collection_path {
        dir.push(sanitise(segment));
    }
    dir
}

/// Make a user-chosen name safe as a single path component.
///
/// Collection and query names are free text, so they can contain `/`,
/// `..`, or NUL. Left alone, `..` would let a name escape the mirror
/// root and overwrite an unrelated file. Every disallowed character
/// becomes `-`, and a name that sanitises to nothing gets a fallback.
fn sanitise(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '\0' => '-',
            c if c.is_control() => '-',
            c => c,
        })
        .collect();

    let trimmed = cleaned.trim().trim_matches('.').trim();
    if trimmed.is_empty() {
        "untitled".to_string()
    } else {
        trimmed.to_string()
    }
}

fn io_err(e: std::io::Error) -> AppError {
    AppError::Library(e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_a_query_to_a_sql_file() {
        let dir = tempfile::tempdir().unwrap();
        write_query(dir.path(), &[], "monthly revenue", "select 1").unwrap();

        let path = dir.path().join("monthly revenue.sql");
        assert!(path.exists());
        assert_eq!(std::fs::read_to_string(path).unwrap(), "select 1");
    }

    #[test]
    fn nests_files_under_collection_folders() {
        let dir = tempfile::tempdir().unwrap();
        write_query(dir.path(), &["Billing", "Monthly"], "mrr", "select 2").unwrap();

        let path = dir.path().join("Billing").join("Monthly").join("mrr.sql");
        assert!(path.exists(), "expected {path:?} to exist");
    }

    #[test]
    fn sanitises_names_that_are_illegal_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        // A slash would silently create a directory; ".." would escape
        // the mirror root entirely.
        write_query(dir.path(), &[], "a/b", "select 1").unwrap();
        write_query(dir.path(), &[".."], "c", "select 1").unwrap();

        let entries: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect();

        assert!(entries.contains(&"a-b.sql".to_string()), "got {entries:?}");
        assert!(
            !dir.path().join("..").join("c.sql").exists(),
            "must not write outside the mirror root"
        );
    }

    #[test]
    fn overwrites_an_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        write_query(dir.path(), &[], "q", "select 1").unwrap();
        write_query(dir.path(), &[], "q", "select 2").unwrap();

        let content = std::fs::read_to_string(dir.path().join("q.sql")).unwrap();
        assert_eq!(content, "select 2");
    }

    #[test]
    fn removes_a_file() {
        let dir = tempfile::tempdir().unwrap();
        write_query(dir.path(), &[], "q", "select 1").unwrap();
        remove_query(dir.path(), &[], "q").unwrap();

        assert!(!dir.path().join("q.sql").exists());
    }

    #[test]
    fn removing_something_absent_is_not_an_error() {
        let dir = tempfile::tempdir().unwrap();
        assert!(remove_query(dir.path(), &[], "never-existed").is_ok());
    }

    // ---- hostile names: additional coverage beyond the plan ----------
    //
    // Query and collection names are free text supplied by the user.
    // `sanitise` is the only thing standing between that text and the
    // filesystem, so it needs to hold against deliberate escape
    // attempts, not just the accidental slash/dot-dot cases above.

    #[test]
    fn a_multi_segment_traversal_name_does_not_escape_the_root() {
        let dir = tempfile::tempdir().unwrap();
        write_query(dir.path(), &[], "../../.zshrc", "select 1").unwrap();

        // Nothing was written outside the mirror root...
        let home = dirs::home_dir().unwrap_or_default().join(".zshrc");
        if home.exists() {
            let content = std::fs::read_to_string(&home).unwrap_or_default();
            assert_ne!(content, "select 1", "must not have overwritten a real dotfile");
        }

        // ...and exactly one sanitised file landed inside the root.
        let entries: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(entries.len(), 1, "got {entries:?}");
        assert!(entries[0].ends_with(".sql"));
    }

    #[test]
    fn a_traversal_collection_path_does_not_escape_the_root() {
        let dir = tempfile::tempdir().unwrap();
        write_query(dir.path(), &["..", "..", "etc"], "passwd", "select 1").unwrap();

        assert!(
            !dir.path().join("..").join("..").join("etc").join("passwd.sql").exists(),
            "must not write outside the mirror root"
        );
        // The sanitised path stays nested inside the temp dir.
        let escaped_up = dir.path().parent().and_then(|p| p.parent());
        if let Some(grandparent) = escaped_up {
            assert!(!grandparent.join("etc").join("passwd.sql").exists());
        }
    }

    #[test]
    fn an_absolute_path_name_is_treated_as_a_plain_filename() {
        let dir = tempfile::tempdir().unwrap();
        write_query(dir.path(), &[], "/etc/passwd", "select 1").unwrap();

        assert!(!Path::new("/etc/passwd.sql").exists(), "must not touch a real absolute path");
        let entries: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert!(entries.contains(&"-etc-passwd.sql".to_string()), "got {entries:?}");
    }

    #[test]
    fn a_null_byte_in_the_name_does_not_error_or_truncate_unsafely() {
        let dir = tempfile::tempdir().unwrap();
        write_query(dir.path(), &[], "evil\0name", "select 1").unwrap();

        let entries: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert!(entries.contains(&"evil-name.sql".to_string()), "got {entries:?}");
    }

    #[test]
    fn an_empty_name_falls_back_instead_of_writing_a_bare_extension() {
        let dir = tempfile::tempdir().unwrap();
        write_query(dir.path(), &[], "", "select 1").unwrap();

        assert!(dir.path().join("untitled.sql").exists());
        assert!(!dir.path().join(".sql").exists());
    }

    #[test]
    fn an_all_dots_name_falls_back_instead_of_resolving_to_a_directory_reference() {
        let dir = tempfile::tempdir().unwrap();
        write_query(dir.path(), &[], "..", "select 1").unwrap();

        assert!(dir.path().join("untitled.sql").exists());
    }
}
