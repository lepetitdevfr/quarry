use crate::conn::config::{ConnectionConfig, SslMode};
use crate::error::AppError;
use deadpool_postgres::{Config as PoolConfig, ManagerConfig, Pool, RecyclingMethod, Runtime};
use tokio_postgres::NoTls;
use tokio_postgres_rustls::MakeRustlsConnect;

/// Ceiling on a single statement, in milliseconds. Set once per
/// connection via `options` below (as `-c statement_timeout=...`)
/// rather than per-query: a per-query `SET` both costs a round-trip on
/// every query and, on a pool that resets session state, is redundant
/// with the reset itself.
const STATEMENT_TIMEOUT_MS: u64 = 30_000;

/// Create a connection pool. This does not open a socket yet —
/// `ping` below is what proves the database is reachable.
pub fn build_pool(cfg: &ConnectionConfig) -> Result<Pool, AppError> {
    let mut pc = PoolConfig::new();
    pc.host = Some(cfg.host.clone());
    pc.port = Some(cfg.port);
    pc.user = Some(cfg.user.clone());
    pc.password = cfg.password.clone();
    pc.dbname = Some(cfg.dbname.clone());
    // Applied via `startup_options`-style `-c` flags at connection time,
    // so it survives for the life of the physical connection and every
    // query on it, without a per-query round-trip.
    pc.options = Some(format!("-c statement_timeout={STATEMENT_TIMEOUT_MS}"));
    pc.manager = Some(ManagerConfig {
        // `Clean` runs `DISCARD ALL` when a connection is returned to
        // the pool: it rolls back any open transaction, resets all
        // session-level `SET` overrides (including a user's own
        // `statement_timeout`), and drops temp tables/prepared
        // statements. Without this, `RecyclingMethod::Fast` hands the
        // next checkout whatever session state the previous caller
        // left behind — including a still-open, possibly aborted,
        // transaction.
        recycling_method: RecyclingMethod::Clean,
    });

    let pool = match cfg.sslmode {
        SslMode::Disable => pc
            .create_pool(Some(Runtime::Tokio1), NoTls)
            .map_err(|e| AppError::Connection(e.to_string()))?,
        // Prefer and Require both attempt TLS. The difference matters
        // only for fallback, which deadpool does not expose; treating
        // Prefer as TLS-on is the safer default.
        SslMode::Prefer | SslMode::Require => {
            let tls = make_tls();
            pc.create_pool(Some(Runtime::Tokio1), tls)
                .map_err(|e| AppError::Connection(e.to_string()))?
        }
    };

    Ok(pool)
}

/// Build a rustls TLS connector trusting the system's standard CA set.
fn make_tls() -> MakeRustlsConnect {
    let mut roots = rustls::RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());

    let config = rustls::ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();

    MakeRustlsConnect::new(config)
}

/// Prove the connection works and report the server version.
pub async fn ping(pool: &Pool) -> Result<String, AppError> {
    let client = pool.get().await?;
    let row = client.query_one("SELECT version()", &[]).await?;
    Ok(row.get::<_, String>(0))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `rustls::ClientConfig::builder()` panics at runtime if no crypto
    /// provider is installed as the process default. Nothing else in the
    /// test suite takes the TLS branch, so this test is what proves the
    /// provider is actually available. `install_default` returns `Err` if
    /// a provider is already installed (e.g. by an earlier test in this
    /// binary), which is fine — we only care that one ends up installed.
    #[test]
    fn builds_a_tls_connector() {
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
        let _ = make_tls();
    }

    /// The TLS branch must be selected for Prefer and Require, and the
    /// NoTls branch for Disable. Building a pool opens no socket, so this
    /// needs no database.
    #[test]
    fn builds_pools_for_every_sslmode() {
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
        for mode in [SslMode::Disable, SslMode::Prefer, SslMode::Require] {
            let cfg = ConnectionConfig {
                host: "localhost".to_string(),
                port: 5432,
                user: "postgres".to_string(),
                dbname: "postgres".to_string(),
                password: None,
                sslmode: mode,
            };
            assert!(build_pool(&cfg).is_ok(), "failed to build pool for {mode:?}");
        }
    }
}
