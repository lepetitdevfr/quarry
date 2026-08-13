use quarry_lib::conn::{build_pool, ConnectionConfig};
use deadpool_postgres::Pool;
use testcontainers_modules::postgres::Postgres;
use testcontainers_modules::testcontainers::runners::AsyncRunner;
use testcontainers_modules::testcontainers::ContainerAsync;

/// A running Postgres container plus a pool pointed at it.
///
/// Hold onto `_container`: when it drops, Docker kills the database.
pub struct TestDb {
    pub pool: Pool,
    pub port: u16,
    _container: ContainerAsync<Postgres>,
}

/// Start a throwaway Postgres. Requires Docker to be running.
pub async fn start() -> TestDb {
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
    let pool = build_pool(&cfg).expect("pool should build");

    TestDb {
        pool,
        port,
        _container: container,
    }
}
