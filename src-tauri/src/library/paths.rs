use crate::error::AppError;
use std::path::PathBuf;

/// Everything Quarry persists lives under one directory so it is easy
/// to find, back up, or delete:
/// `~/Library/Application Support/com.quarry.app/`
pub fn app_dir() -> Result<PathBuf, AppError> {
    let base = dirs::data_dir().ok_or_else(|| {
        AppError::Library("could not locate the application support directory".into())
    })?;
    Ok(base.join("com.quarry.app"))
}

/// The SQLite database — the source of truth for the library.
pub fn database_path() -> Result<PathBuf, AppError> {
    Ok(app_dir()?.join("workspace.db"))
}

/// Root of the `.sql` mirror. Write-only output; see `mirror.rs`.
pub fn mirror_dir() -> Result<PathBuf, AppError> {
    Ok(app_dir()?.join("queries"))
}

/// Create any missing directories. Safe to call repeatedly.
pub fn ensure_dirs() -> Result<(), AppError> {
    std::fs::create_dir_all(app_dir()?).map_err(|e| AppError::Library(e.to_string()))?;
    std::fs::create_dir_all(mirror_dir()?).map_err(|e| AppError::Library(e.to_string()))?;
    Ok(())
}
