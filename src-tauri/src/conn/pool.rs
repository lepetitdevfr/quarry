use crate::conn::config::{ConnectionConfig, SslMode};
use crate::error::AppError;
use deadpool_postgres::{Config as PoolConfig, ManagerConfig, Pool, RecyclingMethod, Runtime};
use tokio_postgres::NoTls;
use tokio_postgres_rustls::MakeRustlsConnect;

/// Create a connection pool. This does not open a socket yet —
/// `ping` below is what proves the database is reachable.
pub fn build_pool(cfg: &ConnectionConfig) -> Result<Pool, AppError> {
    let mut pc = PoolConfig::new();
    pc.host = Some(cfg.host.clone());
    pc.port = Some(cfg.port);
    pc.user = Some(cfg.user.clone());
    pc.password = cfg.password.clone();
    pc.dbname = Some(cfg.dbname.clone());
    pc.manager = Some(ManagerConfig {
        recycling_method: RecyclingMethod::Fast,
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
    let client = pool
        .get()
        .await
        .map_err(|e| AppError::Connection(e.to_string()))?;
    let row = client.query_one("SELECT version()", &[]).await?;
    Ok(row.get::<_, String>(0))
}
