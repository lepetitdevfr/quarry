//! Genuine coverage for the "accepts a self-signed certificate" half of
//! `NoVerifyVerifier`. Unlike `tls_test.rs`, this spins up a Postgres
//! container that actually speaks TLS, with a self-signed certificate
//! generated on the host (via the `openssl` CLI) and copied in — so
//! `sslmode=require` connecting successfully here is real proof the
//! non-verifying rustls config completes a TLS handshake against an
//! untrusted cert, not just that it builds.

use std::process::Command;

use quarry_lib::conn::{build_pool, ping, ConnectionConfig};
use quarry_lib::guard::Policy;
use testcontainers_modules::testcontainers::core::{CopyDataSource, WaitFor};
use testcontainers_modules::testcontainers::runners::AsyncRunner;
use testcontainers_modules::testcontainers::{GenericImage, ImageExt};

const SETUP_SCRIPT: &str = r#"#!/bin/sh
set -e
cp /pg-ssl/server.crt /pg-ssl/server.key "$PGDATA/"
chmod 600 "$PGDATA/server.key"
chmod 644 "$PGDATA/server.crt"
cat >> "$PGDATA/postgresql.conf" <<EOF
ssl = on
ssl_cert_file = 'server.crt'
ssl_key_file = 'server.key'
EOF
"#;

#[tokio::test]
async fn require_accepts_a_self_signed_certificate() {
    // See the comment in `tests/common/mod.rs::start` — each integration
    // test binary is its own process and needs its own crypto provider
    // installed before the first `rustls::ClientConfig::builder()` call.
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();

    let dir = tempfile::tempdir().expect("tempdir");
    let crt = dir.path().join("server.crt");
    let key = dir.path().join("server.key");

    let status = Command::new("openssl")
        .args([
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-keyout",
            key.to_str().unwrap(),
            "-out",
            crt.to_str().unwrap(),
            "-days",
            "1",
            "-subj",
            "/CN=localhost",
        ])
        .status();

    let status = match status {
        Ok(s) => s,
        Err(e) => {
            eprintln!("skipping: no `openssl` CLI on host ({e})");
            return;
        }
    };
    assert!(status.success(), "openssl failed to generate a test cert");

    let image = GenericImage::new("postgres", "16-alpine")
        .with_wait_for(WaitFor::message_on_stderr(
            "database system is ready to accept connections",
        ))
        .with_exposed_port(5432.into())
        .with_env_var("POSTGRES_PASSWORD", "postgres")
        .with_env_var("POSTGRES_USER", "postgres")
        .with_env_var("POSTGRES_DB", "postgres")
        .with_copy_to("/pg-ssl/server.crt", CopyDataSource::File(crt.clone()))
        .with_copy_to("/pg-ssl/server.key", CopyDataSource::File(key.clone()))
        .with_copy_to(
            "/docker-entrypoint-initdb.d/setup-ssl.sh",
            CopyDataSource::Data(SETUP_SCRIPT.as_bytes().to_vec()),
        );

    let container = match image.start().await {
        Ok(c) => c,
        Err(e) => {
            eprintln!("skipping: could not start TLS-enabled postgres container: {e}");
            return;
        }
    };

    let port = container
        .get_host_port_ipv4(5432)
        .await
        .expect("no mapped port");

    let url = format!("postgres://postgres:postgres@localhost:{port}/postgres?sslmode=require");
    let cfg = ConnectionConfig::from_url(&url).expect("test URL should parse");
    let pool = build_pool(&cfg, Policy::Free).expect("pool should build");

    let version = ping(&pool)
        .await
        .expect("require should complete a TLS handshake against a self-signed cert");
    assert!(version.contains("PostgreSQL"));
}
