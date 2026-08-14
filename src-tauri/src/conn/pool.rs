use crate::conn::config::{ConnectionConfig, SslMode};
use crate::error::AppError;
use deadpool_postgres::{
    Config as PoolConfig, ManagerConfig, Pool, RecyclingMethod, Runtime,
    SslMode as DeadpoolSslMode,
};
use rustls::client::danger::{
    HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier,
};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};
use std::sync::Arc;
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

    // Tell the driver what to do when the server refuses TLS.
    //
    // This is load-bearing and easy to get wrong: left unset, deadpool
    // defaults to `Prefer`, which attempts TLS and then silently falls
    // back to an unencrypted connection. A user who picked "require"
    // would believe their traffic was encrypted when it was not.
    pc.ssl_mode = Some(match cfg.sslmode {
        SslMode::Disable => DeadpoolSslMode::Disable,
        SslMode::Prefer => DeadpoolSslMode::Prefer,
        // deadpool has no verify variant: verification (or the deliberate
        // lack of it) happens inside our rustls config in `make_tls`, not
        // here. Both `Require` and `VerifyFull` must mandate TLS at the
        // deadpool level, so both map to deadpool's `Require`.
        SslMode::Require | SslMode::VerifyFull => DeadpoolSslMode::Require,
    });

    let pool = match cfg.sslmode {
        SslMode::Disable => pc
            .create_pool(Some(Runtime::Tokio1), NoTls)
            .map_err(|e| AppError::Connection(e.to_string()))?,
        // All three attempt TLS; `ssl_mode` above decides whether falling
        // back to plaintext is allowed when the server says no, and
        // `make_tls` decides whether the certificate itself is checked.
        SslMode::Prefer | SslMode::Require | SslMode::VerifyFull => {
            let tls = make_tls(cfg.sslmode);
            pc.create_pool(Some(Runtime::Tokio1), tls)
                .map_err(|e| AppError::Connection(e.to_string()))?
        }
    };

    Ok(pool)
}

/// Build a rustls TLS connector for the given mode.
///
/// `VerifyFull` gets a normal verifying config, trusting the standard
/// webpki CA set and checking the presented hostname. `Prefer` and
/// `Require` get [`NoVerifyVerifier`] instead — see its doc comment for
/// why that is correct, not a bug.
fn make_tls(mode: SslMode) -> MakeRustlsConnect {
    let config = if mode == SslMode::VerifyFull {
        let mut roots = rustls::RootCertStore::empty();
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());

        rustls::ClientConfig::builder()
            .with_root_certificates(roots)
            .with_no_client_auth()
    } else {
        rustls::ClientConfig::builder()
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(NoVerifyVerifier::new()))
            .with_no_client_auth()
    };

    MakeRustlsConnect::new(config)
}

/// A `ServerCertVerifier` that accepts *any* certificate, including
/// self-signed and expired ones, and never checks that the certificate's
/// name matches the host we dialled.
///
/// This is not an oversight. It is what libpq's `sslmode=require` means:
/// "encrypt the connection, but don't bother proving who's on the other
/// end." We need it because managed hosts like Railway put their
/// database behind a TLS proxy whose certificate is self-signed and
/// issued to `CN=localhost` — a name nobody outside the host's own
/// network could ever verify, and that no public CA has signed. Rejecting
/// that certificate would make the database unreachable over TLS at all.
///
/// What this buys you: protection from passive eavesdropping — someone
/// watching the wire sees ciphertext, not your queries or credentials in
/// the clear. What it does NOT buy you: protection from an active
/// man-in-the-middle. Anyone who can intercept and re-terminate the TCP
/// connection (a malicious proxy, a compromised network, DNS hijacking)
/// can present their own certificate and this verifier will wave it
/// through. If that threat matters for a given connection, the fix is to
/// use `sslmode=verify-full` with a CA that can actually authenticate the
/// server, not to "fix" this verifier — that's `VerifyFull`'s job, not
/// this one's.
///
/// The signature-verification methods below are NOT stubbed: they
/// delegate to rustls's own cryptographic checks, so a corrupted or
/// forged handshake still fails. Only identity (chain-of-trust and
/// hostname) is skipped.
#[derive(Debug)]
struct NoVerifyVerifier {
    provider: Arc<rustls::crypto::CryptoProvider>,
}

impl NoVerifyVerifier {
    fn new() -> Self {
        let provider = rustls::crypto::CryptoProvider::get_default()
            .cloned()
            .unwrap_or_else(|| Arc::new(rustls::crypto::aws_lc_rs::default_provider()));
        Self { provider }
    }
}

impl ServerCertVerifier for NoVerifyVerifier {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        // The whole point: no chain-of-trust check, no hostname check.
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        // Identity is unchecked, but the handshake signature itself is
        // still verified cryptographically: this is what stops an
        // on-path attacker from tampering with the handshake undetected.
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
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
        let _ = make_tls(SslMode::Require);
        let _ = make_tls(SslMode::VerifyFull);
    }

    /// The TLS branch must be selected for Prefer, Require and VerifyFull,
    /// and the NoTls branch for Disable. Building a pool opens no socket,
    /// so this needs no database.
    #[test]
    fn builds_pools_for_every_sslmode() {
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
        for mode in [
            SslMode::Disable,
            SslMode::Prefer,
            SslMode::Require,
            SslMode::VerifyFull,
        ] {
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
