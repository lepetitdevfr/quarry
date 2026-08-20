use crate::conn::config::{ConnectionConfig, SslMode};
use crate::error::AppError;
use crate::guard::Policy;
use deadpool_postgres::{
    Config as PoolConfig, ManagerConfig, Pool, RecyclingMethod, Runtime, SslMode as DeadpoolSslMode,
};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};
use std::sync::Arc;
use std::time::Duration;
use tokio_postgres::NoTls;
use tokio_postgres_rustls::MakeRustlsConnect;

/// Ceiling on a single statement, in milliseconds. Set once per
/// connection via `options` below (as `-c statement_timeout=...`)
/// rather than per-query: a per-query `SET` both costs a round-trip on
/// every query and, on a pool that resets session state, is redundant
/// with the reset itself.
const STATEMENT_TIMEOUT_MS: u64 = 30_000;

/// The `-c` flags applied at connection time.
///
/// These survive for the life of the physical connection *and* the
/// `DISCARD ALL` that runs when it returns to the pool — because they
/// are the values `DISCARD ALL` resets to. That is what makes
/// `default_transaction_read_only` a real protection rather than a
/// session setting a stray `SET` could undo.
fn startup_options(policy: Policy) -> String {
    let mut options = format!("-c statement_timeout={STATEMENT_TIMEOUT_MS}");

    if policy == Policy::ReadOnly {
        // Layer two of the guard. Every transaction on this connection
        // starts read-only; only an explicit `BEGIN READ WRITE` opts
        // out, which execution does exactly while unlocked.
        options.push_str(" -c default_transaction_read_only=on");
    }

    options
}

/// Create a connection pool. This does not open a socket yet —
/// `ping` below is what proves the database is reachable.
///
/// `policy` decides whether the pool's connections start read-only at
/// the Postgres level (see `startup_options`) — the guard's second,
/// independent layer of enforcement.
pub fn build_pool(cfg: &ConnectionConfig, policy: Policy) -> Result<Pool, AppError> {
    let mut pc = PoolConfig::new();
    pc.host = Some(cfg.host.clone());
    pc.port = Some(cfg.port);
    pc.user = Some(cfg.user.clone());
    pc.password = cfg.password.clone();
    pc.dbname = Some(cfg.dbname.clone());
    // Applied via `startup_options`-style `-c` flags at connection time,
    // so it survives for the life of the physical connection and every
    // query on it, without a per-query round-trip.
    pc.options = Some(startup_options(policy));
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

/// How long to wait for a server to answer before giving up on it.
///
/// Nothing below this call has a ceiling of its own: a paused container,
/// a dropped VPN or a firewalled port leaves the TCP connect hanging,
/// and the UI sat there with no spinner, no error and no way out until
/// the server came back — then completed the switch silently, minutes
/// later. Ten seconds is longer than any healthy handshake and shorter
/// than a person's patience.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// Fail a connection attempt that has taken too long, naming the target
/// so the message says which server went quiet.
///
/// Split out from `ping` so the deadline can be tested without a
/// database: the failure it exists for is precisely the one no reachable
/// server will reproduce.
async fn within_connect_timeout<T>(
    target: &str,
    work: impl std::future::Future<Output = Result<T, AppError>>,
) -> Result<T, AppError> {
    match tokio::time::timeout(CONNECT_TIMEOUT, work).await {
        Ok(result) => result,
        Err(_) => Err(AppError::Connection(format!(
            "{target} did not answer within {}s",
            CONNECT_TIMEOUT.as_secs()
        ))),
    }
}

/// Prove the connection works and report the server version.
///
/// `target` is only for the message — `host:port`, so a timeout says
/// which server it waited for.
pub async fn ping(pool: &Pool, target: &str) -> Result<String, AppError> {
    within_connect_timeout(target, async {
        let client = pool.get().await?;
        let row = client.query_one("SELECT version()", &[]).await?;
        Ok(row.get::<_, String>(0))
    })
    .await
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
    /// A server that never answers must fail on its own, with a message
    /// that names it. Driven on a paused clock, so the ten-second
    /// deadline costs the test nothing: `tokio::time::pause` makes time
    /// jump to the next deadline whenever the runtime goes idle.
    #[tokio::test(start_paused = true)]
    async fn a_server_that_never_answers_times_out_and_says_which_one() {
        let err = within_connect_timeout::<String>("db.example:5432", async {
            std::future::pending::<Result<String, AppError>>().await
        })
        .await
        .expect_err("a hang must not be reported as a connection");

        let message = err.to_string();
        assert!(
            message.contains("db.example:5432") && message.contains("10s"),
            "message was: {message}"
        );
    }

    /// The deadline must not touch a server that does answer.
    #[tokio::test(start_paused = true)]
    async fn a_server_that_answers_is_left_alone() {
        let version =
            within_connect_timeout("db.example:5432", async { Ok("PostgreSQL 17".to_string()) })
                .await
                .expect("an answer inside the deadline is not a timeout");

        assert_eq!(version, "PostgreSQL 17");
    }

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
            assert!(
                build_pool(&cfg, Policy::Free).is_ok(),
                "failed to build pool for {mode:?}"
            );
        }
    }

    /// The second layer of the guard. This is the option that protects
    /// against code paths which forget to ask the classifier — including
    /// ones not written yet.
    #[test]
    fn a_read_only_pool_asks_postgres_to_refuse_writes() {
        let cfg = ConnectionConfig {
            host: "localhost".to_string(),
            port: 5432,
            user: "postgres".to_string(),
            dbname: "postgres".to_string(),
            password: None,
            sslmode: SslMode::Disable,
        };

        assert!(startup_options(Policy::ReadOnly).contains("default_transaction_read_only=on"));
        assert!(!startup_options(Policy::Free).contains("default_transaction_read_only"));

        // Both still carry the statement timeout, which is not part of
        // the guard and must not be lost.
        assert!(startup_options(Policy::ReadOnly).contains("statement_timeout"));
        assert!(startup_options(Policy::Free).contains("statement_timeout"));

        assert!(build_pool(&cfg, Policy::ReadOnly).is_ok());
    }
}
