use quarry_lib::conn::{build_pool, ConnectionConfig};
use quarry_lib::guard::Policy;
use deadpool_postgres::Pool;
use testcontainers_modules::postgres::Postgres;
use testcontainers_modules::testcontainers::runners::AsyncRunner;
use testcontainers_modules::testcontainers::ContainerAsync;

/// A running Postgres container plus a pool pointed at it.
///
/// Hold onto `_container`: when it drops, Docker kills the database.
///
/// `allow(dead_code)` because every file in `tests/` compiles as its own
/// binary with its own private copy of this module. No single binary
/// uses all of the harness — `exec_test` wants `pool`, `guard_db_test`
/// wants `port` and `config_for` — so each one can truthfully report
/// the parts it does not touch as dead. The alternative is a `cfg`
/// maze that says less than this comment does.
#[allow(dead_code)]
pub struct TestDb {
    pub pool: Pool,
    pub port: u16,
    _container: ContainerAsync<Postgres>,
}

/// Start a throwaway Postgres. Requires Docker to be running.
pub async fn start() -> TestDb {
    // `rustls::ClientConfig::builder()` (in `make_tls`) panics if no
    // process-level crypto provider is installed. In the real app this
    // happens once in `lib.rs::run`; each integration test binary is its
    // own process, so it needs the same setup. `install_default` errors
    // if a provider is already installed (e.g. a prior test in this
    // binary) — that's fine, we only care that one ends up installed.
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();

    let container = Postgres::default()
        .start()
        .await
        .expect("failed to start postgres container — is Docker running?");

    let port = container
        .get_host_port_ipv4(5432)
        .await
        .expect("no mapped port");

    // testcontainers' postgres image defaults: user/password/db = postgres.
    let url = format!("postgres://postgres:postgres@localhost:{port}/postgres?sslmode=disable");
    let cfg = ConnectionConfig::from_url(&url).expect("test URL should parse");
    let pool = build_pool(&cfg, Policy::Free).expect("pool should build");

    TestDb {
        pool,
        port,
        _container: container,
    }
}

/// The same connection config `start` used, so a test can build a second
/// pool — with a different policy — against the same container.
///
/// `allow(dead_code)` for the same reason as `TestDb`: only the guard
/// and editing test binaries build a second pool.
#[allow(dead_code)]
pub fn config_for(port: u16) -> ConnectionConfig {
    let url = format!("postgres://postgres:postgres@localhost:{port}/postgres?sslmode=disable");
    ConnectionConfig::from_url(&url).expect("test URL should parse")
}
