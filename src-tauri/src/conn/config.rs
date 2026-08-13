use crate::error::AppError;
use percent_encoding::percent_decode_str;
use serde::{Deserialize, Serialize};
use url::Url;

/// How to negotiate TLS. Mirrors libpq's `sslmode`, minus the modes we
/// do not support in v1 (`verify-ca`, `verify-full` need a cert UI).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SslMode {
    Disable,
    Prefer,
    Require,
}

/// Everything needed to open a connection. No secrets are logged: the
/// `Debug` impl below masks the password deliberately.
#[derive(Clone, PartialEq, Serialize, Deserialize)]
pub struct ConnectionConfig {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub dbname: String,
    pub password: Option<String>,
    pub sslmode: SslMode,
}

// Hand-written so an accidental `{:?}` in a log never prints a password.
impl std::fmt::Debug for ConnectionConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ConnectionConfig")
            .field("host", &self.host)
            .field("port", &self.port)
            .field("user", &self.user)
            .field("dbname", &self.dbname)
            .field("password", &self.password.as_ref().map(|_| "***"))
            .field("sslmode", &self.sslmode)
            .finish()
    }
}

impl ConnectionConfig {
    /// Parse a `postgres://` URL. Missing parts get libpq's defaults.
    ///
    /// Returns `Result<Self, AppError>`: the `?` operator below returns
    /// early on the `Err` branch, so the happy path stays flat.
    pub fn from_url(raw: &str) -> Result<Self, AppError> {
        let url = Url::parse(raw.trim())
            .map_err(|e| AppError::InvalidUrl(e.to_string()))?;

        match url.scheme() {
            "postgres" | "postgresql" => {}
            other => {
                return Err(AppError::InvalidUrl(format!(
                    "expected a postgres:// URL, got {other}://"
                )))
            }
        }

        // `url` keeps the path as "/dbname"; strip the leading slash.
        let dbname = url.path().trim_start_matches('/').to_string();
        if dbname.is_empty() {
            return Err(AppError::InvalidUrl(
                "URL is missing a database name (expected postgres://host/dbname)"
                    .to_string(),
            ));
        }

        let user = match decode(url.username()) {
            u if u.is_empty() => "postgres".to_string(),
            u => u,
        };

        let password = url.password().map(decode).filter(|p| !p.is_empty());

        let sslmode = url
            .query_pairs()
            .find(|(k, _)| k == "sslmode")
            .map(|(_, v)| match v.as_ref() {
                "disable" => SslMode::Disable,
                "require" | "verify-ca" | "verify-full" => SslMode::Require,
                _ => SslMode::Prefer,
            })
            .unwrap_or(SslMode::Prefer);

        let host = match url.host_str() {
            Some(h) if !h.is_empty() => h.to_string(),
            _ => "localhost".to_string(),
        };

        Ok(ConnectionConfig {
            host,
            port: url.port().unwrap_or(5432),
            user,
            dbname,
            password,
            sslmode,
        })
    }
}

/// URL-decode a component: `a%40b` becomes `a@b`. Invalid UTF-8 falls
/// back to the raw text rather than failing the whole parse.
fn decode(s: &str) -> String {
    percent_decode_str(s).decode_utf8_lossy().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_full_url() {
        let c = ConnectionConfig::from_url(
            "postgres://alice:s3cret@db.example.com:6432/kolecto",
        )
        .unwrap();
        assert_eq!(c.host, "db.example.com");
        assert_eq!(c.port, 6432);
        assert_eq!(c.user, "alice");
        assert_eq!(c.password.as_deref(), Some("s3cret"));
        assert_eq!(c.dbname, "kolecto");
        assert_eq!(c.sslmode, SslMode::Prefer);
    }

    #[test]
    fn applies_defaults_for_missing_parts() {
        let c = ConnectionConfig::from_url("postgres:///mydb").unwrap();
        assert_eq!(c.host, "localhost");
        assert_eq!(c.port, 5432);
        assert_eq!(c.user, "postgres");
        assert_eq!(c.password, None);
        assert_eq!(c.dbname, "mydb");
    }

    #[test]
    fn accepts_the_postgresql_scheme_too() {
        let c = ConnectionConfig::from_url("postgresql://localhost/mydb").unwrap();
        assert_eq!(c.dbname, "mydb");
    }

    #[test]
    fn reads_sslmode_from_the_query_string() {
        let c = ConnectionConfig::from_url(
            "postgres://localhost/mydb?sslmode=require",
        )
        .unwrap();
        assert_eq!(c.sslmode, SslMode::Require);
    }

    #[test]
    fn percent_decodes_credentials() {
        let c = ConnectionConfig::from_url(
            "postgres://a%40b:p%40ss@localhost/mydb",
        )
        .unwrap();
        assert_eq!(c.user, "a@b");
        assert_eq!(c.password.as_deref(), Some("p@ss"));
    }

    #[test]
    fn rejects_a_non_postgres_scheme() {
        let err = ConnectionConfig::from_url("mysql://localhost/mydb").unwrap_err();
        assert!(err.to_string().contains("mysql"));
    }

    #[test]
    fn rejects_a_url_without_a_database_name() {
        let err = ConnectionConfig::from_url("postgres://localhost").unwrap_err();
        assert!(err.to_string().contains("database"));
    }

    #[test]
    fn rejects_garbage() {
        assert!(ConnectionConfig::from_url("not a url").is_err());
    }
}
