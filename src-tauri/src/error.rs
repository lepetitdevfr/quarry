use serde::Serialize;

/// One error type for everything that can cross the IPC boundary.
///
/// `thiserror` generates the `Display` impl from the `#[error(...)]`
/// attributes, so each variant carries its own user-facing message.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("invalid connection URL: {0}")]
    InvalidUrl(String),

    #[error("connection failed: {0}")]
    Connection(String),

    #[error("query failed: {message}")]
    Query {
        message: String,
        /// Postgres SQLSTATE code, e.g. "42P01" for undefined_table.
        code: Option<String>,
        /// Byte offset of the error within the submitted SQL, 1-based.
        position: Option<u32>,
    },

    #[error("keychain error: {0}")]
    Keychain(String),

    #[error("library error: {0}")]
    Library(String),

    #[error("this connection needs a password")]
    PasswordRequired,

    #[error("could not write the file: {0}")]
    Export(String),
}

/// The shape the UI receives. Tauri requires command errors to be
/// `Serialize`; `AppError` itself is not, so it converts into this.
#[derive(Debug, Serialize)]
pub struct ErrorPayload {
    pub kind: String,
    pub message: String,
    pub code: Option<String>,
    pub position: Option<u32>,
}

impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let (kind, code, position) = match self {
            AppError::InvalidUrl(_) => ("invalid_url", None, None),
            AppError::Connection(_) => ("connection", None, None),
            AppError::Query { code, position, .. } => {
                ("query", code.clone(), *position)
            }
            AppError::Keychain(_) => ("keychain", None, None),
            AppError::Library(_) => ("library", None, None),
            AppError::PasswordRequired => ("password_required", None, None),
            AppError::Export(_) => ("export", None, None),
        };
        ErrorPayload {
            kind: kind.to_string(),
            message: self.to_string(),
            code,
            position,
        }
        .serialize(s)
    }
}

/// Convert a raw postgres error into `AppError::Query`, preserving the
/// SQLSTATE code and character position so the editor can underline the
/// offending token.
impl From<tokio_postgres::Error> for AppError {
    fn from(e: tokio_postgres::Error) -> Self {
        if let Some(db) = e.as_db_error() {
            AppError::Query {
                message: db.message().to_string(),
                code: Some(db.code().code().to_string()),
                position: match db.position() {
                    Some(tokio_postgres::error::ErrorPosition::Original(p)) => Some(*p),
                    Some(tokio_postgres::error::ErrorPosition::Internal { position, .. }) => {
                        Some(*position)
                    }
                    None => None,
                },
            }
        } else {
            AppError::Connection(e.to_string())
        }
    }
}

/// Convert a pool checkout failure into `AppError`, preserving the
/// SQLSTATE when the pool's backend error is a real Postgres error
/// (e.g. a wrong password, `28P01`, or a missing database, `3D000`).
/// Without this, every checkout failure — including ones with a
/// perfectly good SQLSTATE — collapsed into `AppError::Connection` with
/// `code: None`, hiding the reason from the UI.
impl From<deadpool_postgres::PoolError> for AppError {
    fn from(e: deadpool_postgres::PoolError) -> Self {
        match e {
            deadpool_postgres::PoolError::Backend(e) => e.into(),
            other => AppError::Connection(other.to_string()),
        }
    }
}
