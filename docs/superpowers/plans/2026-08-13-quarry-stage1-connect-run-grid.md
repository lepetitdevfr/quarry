# Quarry Stage 1 — Connect, Run, Grid — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Tauri desktop app that connects to a PostgreSQL database from a pasted connection URL, runs SQL, and displays results in a virtualized grid.

**Architecture:** Rust core owns connections, execution, and type conversion; it exposes three Tauri commands (`connect`, `run_query`, `disconnect`) to a React/TypeScript UI. Rust modules are small and independently testable: `conn` (config + pool), `exec` (execution + value conversion), `secrets` (Keychain). No safety guard yet — Stage 3 adds it, and this stage's `exec` entry point is where it will slot in.

**Tech Stack:** Tauri 2, Rust 1.97 (`tokio-postgres`, `deadpool-postgres`, `rust_decimal`, `security-framework`), React 19 + TypeScript + Vite, CodeMirror 6, TanStack Virtual, `testcontainers` for integration tests, Vitest for TS unit tests.

**Spec:** `docs/superpowers/specs/2026-08-13-quarry-design.md`

**Reading note for the implementer:** the developer is new to Rust. Rust steps below spell out the non-obvious parts (ownership, `?`, `async`, trait bounds) in comments. Keep code plain — no clever generics, no macros beyond `derive`.

---

## Prerequisites (already verified on this machine)

- `rustc 1.97.1`, `cargo 1.97.1` — installed via Homebrew rustup, PATH set in `~/.zshrc`
- Docker Desktop running (required by integration tests)
- Node 22.19.0, npm 10.9.3
- Xcode Command Line Tools (provides the linker)

If `cargo --version` fails in a fresh shell, run `export PATH="/opt/homebrew/opt/rustup/bin:$PATH"`.

---

## File Structure

Files created in this stage, and what each is responsible for.

### Rust (`src-tauri/`)

| File | Responsibility |
|------|----------------|
| `src/lib.rs` | Tauri app setup, `AppState`, command registration |
| `src/error.rs` | `AppError` — one error type crossing IPC, serializable |
| `src/conn/mod.rs` | Module re-exports |
| `src/conn/config.rs` | `ConnectionConfig`, URL parsing (pure, no I/O) |
| `src/conn/pool.rs` | Pool creation, TLS selection, liveness check |
| `src/exec/mod.rs` | Module re-exports |
| `src/exec/value.rs` | Postgres value → `serde_json::Value` conversion |
| `src/exec/run.rs` | `run_query` — execute, time, collect rows |
| `src/secrets.rs` | macOS Keychain read/write/delete |
| `src/commands.rs` | `#[tauri::command]` functions — thin wrappers only |
| `tests/common/mod.rs` | Test helper: start a throwaway Postgres container |
| `tests/exec_test.rs` | Integration tests against real Postgres |

### TypeScript (`src/`)

| File | Responsibility |
|------|----------------|
| `src/types.ts` | TS mirrors of the Rust IPC structs |
| `src/lib/ipc.ts` | Typed `invoke` wrappers — the only file that calls Tauri |
| `src/lib/format.ts` | Cell formatting (null vs empty string, JSON, dates) |
| `src/lib/format.test.ts` | Vitest unit tests for formatting |
| `src/components/ConnectionForm.tsx` | Paste a URL, connect |
| `src/components/SqlEditor.tsx` | CodeMirror editor + Run |
| `src/components/ResultGrid.tsx` | Virtualized result table |
| `src/components/StatusBar.tsx` | Row count, duration, errors |
| `src/App.tsx` | Composition + session state |

---

## Task 1: Scaffold the Tauri app into the existing repo

The repo already exists at `/Users/lepetitdev/dev/quarry` with `docs/` and a git history, so scaffolding happens in a temp directory and is then moved in — `create-tauri-app` refuses to write into a non-empty directory.

**Files:**
- Create: `package.json`, `vite.config.ts`, `index.html`, `src/`, `src-tauri/`
- Modify: `.gitignore`

- [ ] **Step 1: Scaffold into a temp directory**

```bash
cd /tmp && rm -rf quarry-scaffold
npm create tauri-app@latest quarry-scaffold -- --template react-ts --manager npm --identifier com.quarry.app --yes
```

Expected: a `/tmp/quarry-scaffold` directory containing `src/`, `src-tauri/`, `package.json`.

- [ ] **Step 2: Move the scaffold into the repo**

```bash
cd /tmp/quarry-scaffold
rm -f README.md .gitignore
cp -R . /Users/lepetitdev/dev/quarry/
cd /Users/lepetitdev/dev/quarry && rm -rf /tmp/quarry-scaffold
ls
```

Expected: `docs`, `index.html`, `package.json`, `src`, `src-tauri`, `vite.config.ts`, `README.md`.

- [ ] **Step 3: Add ignore rules**

Create `/Users/lepetitdev/dev/quarry/.gitignore`:

```gitignore
node_modules/
dist/
src-tauri/target/
.DS_Store
*.log
```

- [ ] **Step 4: Install dependencies and verify the app builds**

```bash
cd /Users/lepetitdev/dev/quarry && npm install
cd src-tauri && cargo build 2>&1 | tail -5
```

Expected: `Finished \`dev\` profile` (first build takes several minutes — Tauri compiles a lot).

- [ ] **Step 5: Commit**

```bash
cd /Users/lepetitdev/dev/quarry
git add -A
git commit -m "chore: scaffold Tauri 2 + React + TypeScript app"
```

---

## Task 2: Add Rust dependencies and the module skeleton

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Create: `src-tauri/src/error.rs`, `src-tauri/src/conn/mod.rs`, `src-tauri/src/exec/mod.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add dependencies**

`cargo add` resolves current versions, avoiding stale pins.

```bash
cd /Users/lepetitdev/dev/quarry/src-tauri
cargo add tokio --features rt-multi-thread,macros,time
cargo add tokio-postgres --features with-serde_json-1,with-chrono-0_4,with-uuid-1
cargo add deadpool-postgres
cargo add postgres-types
cargo add rust_decimal --features db-postgres
cargo add chrono uuid url percent-encoding thiserror
cargo add tokio-postgres-rustls rustls webpki-roots
cargo add security-framework
cargo add --dev testcontainers-modules --features postgres
```

- [ ] **Step 2: Create the error type**

Create `src-tauri/src/error.rs`:

```rust
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

    #[error("no such connection: {0}")]
    UnknownConnection(String),

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
            AppError::UnknownConnection(_) => ("unknown_connection", None, None),
            AppError::Query { code, position, .. } => {
                ("query", code.clone(), *position)
            }
            AppError::Keychain(_) => ("keychain", None, None),
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
```

- [ ] **Step 3: Create empty module files**

Create `src-tauri/src/conn/mod.rs`:

```rust
pub mod config;
pub mod pool;

pub use config::{ConnectionConfig, SslMode};
pub use pool::{build_pool, ping};
```

Create `src-tauri/src/exec/mod.rs`:

```rust
pub mod run;
pub mod value;

pub use run::{run_query, ColumnMeta, QueryResult};
```

- [ ] **Step 4: Wire modules into the crate root**

Add to the top of `src-tauri/src/lib.rs`, above the existing content:

```rust
pub mod commands;
pub mod conn;
pub mod error;
pub mod exec;
pub mod secrets;
```

The build will fail until Tasks 3–8 create those files; that is expected. Verify only that `Cargo.toml` parses:

```bash
cd /Users/lepetitdev/dev/quarry/src-tauri && cargo metadata --no-deps >/dev/null && echo "manifest OK"
```

Expected: `manifest OK`

- [ ] **Step 5: Commit**

```bash
cd /Users/lepetitdev/dev/quarry
git add -A
git commit -m "chore: add Rust dependencies and module skeleton"
```

---

## Task 3: Parse a connection URL (pure function, TDD)

`ConnectionConfig::from_url` has no I/O, so it is tested with plain unit tests and no database.

**Files:**
- Create: `src-tauri/src/conn/config.rs`

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/src/conn/config.rs` containing ONLY the test module for now:

```rust
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
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/lepetitdev/dev/quarry/src-tauri && cargo test --lib conn::config 2>&1 | tail -20
```

Expected: compilation errors — `cannot find type ConnectionConfig in this scope`.

- [ ] **Step 3: Write the implementation**

Insert ABOVE the `#[cfg(test)]` module in `src-tauri/src/conn/config.rs`:

```rust
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

        Ok(ConnectionConfig {
            host: url.host_str().unwrap_or("localhost").to_string(),
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
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/lepetitdev/dev/quarry/src-tauri && cargo test --lib conn::config 2>&1 | tail -15
```

Expected: `test result: ok. 8 passed; 0 failed`

- [ ] **Step 5: Commit**

```bash
cd /Users/lepetitdev/dev/quarry
git add src-tauri/src/conn/config.rs
git commit -m "feat(conn): parse postgres connection URLs"
```

---

## Task 4: Build the connection pool

**Files:**
- Create: `src-tauri/src/conn/pool.rs`

- [ ] **Step 1: Write the implementation**

There is no unit test here — the function's whole job is I/O, and Task 6 covers it against a real server.

Create `src-tauri/src/conn/pool.rs`:

```rust
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
```

- [ ] **Step 2: Verify it compiles**

```bash
cd /Users/lepetitdev/dev/quarry/src-tauri && cargo check 2>&1 | grep -E "^(error|warning: unused)" | head -20
```

Expected: errors only about the not-yet-created `commands`, `exec::run`, `exec::value`, and `secrets` modules. If rustls' API differs from the code above, read the compiler message — it names the expected builder method — and adjust.

- [ ] **Step 3: Commit**

```bash
cd /Users/lepetitdev/dev/quarry
git add src-tauri/src/conn/pool.rs
git commit -m "feat(conn): build connection pool with optional TLS"
```

---

## Task 5: Set up the integration test harness

Integration tests run against a real Postgres in Docker. This is worth the setup: type conversion bugs (Task 6) do not reproduce against mocks.

**Files:**
- Create: `src-tauri/tests/common/mod.rs`

- [ ] **Step 1: Write the harness**

Create `src-tauri/tests/common/mod.rs`:

```rust
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
        _container: container,
    }
}
```

- [ ] **Step 2: Confirm the library's crate name**

Integration tests import the crate by the name in `Cargo.toml`. Check it:

```bash
cd /Users/lepetitdev/dev/quarry/src-tauri && grep -A2 "^\[lib\]" Cargo.toml
```

Expected: a `name = "quarry_lib"` line. If the name differs, replace `quarry_lib` in the test file above with the actual name.

- [ ] **Step 3: Commit**

```bash
cd /Users/lepetitdev/dev/quarry
git add src-tauri/tests/common/mod.rs
git commit -m "test: add postgres testcontainer harness"
```

---

## Task 6: Convert Postgres values to JSON (TDD, integration)

Every Postgres type must reach the UI as JSON. Wrong conversions here are silent data corruption, so the tests come first and cover every type the app claims to support.

**Files:**
- Create: `src-tauri/src/exec/value.rs`
- Create: `src-tauri/tests/exec_test.rs`

- [ ] **Step 1: Write the failing test**

Create `src-tauri/tests/exec_test.rs`:

```rust
mod common;

use quarry_lib::exec::run_query;
use serde_json::json;

#[tokio::test]
async fn converts_every_supported_type() {
    let db = common::start().await;

    let sql = "SELECT
        true::bool                              as a_bool,
        42::int2                                as a_int2,
        42::int4                                as a_int4,
        42::int8                                as a_int8,
        1.5::float4                             as a_float4,
        1.5::float8                             as a_float8,
        '12.34'::numeric                        as a_numeric,
        'hello'::text                           as a_text,
        'vc'::varchar                           as a_varchar,
        '2026-01-04'::date                      as a_date,
        '2026-01-04 10:30:00'::timestamp        as a_timestamp,
        '{\"k\": 1}'::jsonb                     as a_jsonb,
        '00000000-0000-0000-0000-000000000001'::uuid as a_uuid,
        null::text                              as a_null,
        ''::text                                as an_empty_string";

    let result = run_query(&db.pool, sql).await.expect("query should succeed");

    assert_eq!(result.row_count, 1);
    let row = &result.rows[0];
    let col = |name: &str| {
        let i = result
            .columns
            .iter()
            .position(|c| c.name == name)
            .unwrap_or_else(|| panic!("no column {name}"));
        row[i].clone()
    };

    assert_eq!(col("a_bool"), json!(true));
    assert_eq!(col("a_int2"), json!(42));
    assert_eq!(col("a_int4"), json!(42));
    assert_eq!(col("a_int8"), json!(42));
    assert_eq!(col("a_float4"), json!(1.5));
    assert_eq!(col("a_float8"), json!(1.5));
    assert_eq!(col("a_numeric"), json!("12.34"));
    assert_eq!(col("a_text"), json!("hello"));
    assert_eq!(col("a_varchar"), json!("vc"));
    assert_eq!(col("a_date"), json!("2026-01-04"));
    assert_eq!(col("a_timestamp"), json!("2026-01-04T10:30:00"));
    assert_eq!(col("a_jsonb"), json!({"k": 1}));
    assert_eq!(
        col("a_uuid"),
        json!("00000000-0000-0000-0000-000000000001")
    );

    // The distinction the UI depends on: NULL and '' must not collapse.
    assert_eq!(col("a_null"), serde_json::Value::Null);
    assert_eq!(col("an_empty_string"), json!(""));
}

#[tokio::test]
async fn reports_column_names_and_types() {
    let db = common::start().await;

    let result = run_query(&db.pool, "SELECT 1 as n, 'x' as s")
        .await
        .expect("query should succeed");

    assert_eq!(result.columns.len(), 2);
    assert_eq!(result.columns[0].name, "n");
    assert_eq!(result.columns[0].type_name, "int4");
    assert_eq!(result.columns[1].name, "s");
    assert_eq!(result.columns[1].type_name, "text");
}

#[tokio::test]
async fn returns_an_empty_result_without_error() {
    let db = common::start().await;

    let result = run_query(&db.pool, "SELECT 1 WHERE false")
        .await
        .expect("query should succeed");

    assert_eq!(result.row_count, 0);
    assert!(result.rows.is_empty());
    assert_eq!(result.columns.len(), 1);
}

#[tokio::test]
async fn surfaces_postgres_errors_with_code_and_position() {
    let db = common::start().await;

    let err = run_query(&db.pool, "SELECT * FROM table_that_does_not_exist")
        .await
        .expect_err("query should fail");

    let msg = err.to_string();
    assert!(
        msg.contains("table_that_does_not_exist"),
        "message should name the missing table, got: {msg}"
    );
}

#[tokio::test]
async fn unsupported_types_do_not_crash_the_query() {
    let db = common::start().await;

    // point has no Rust mapping in our conversion table.
    let result = run_query(&db.pool, "SELECT '(1,2)'::point as p")
        .await
        .expect("query should still succeed");

    let cell = &result.rows[0][0];
    assert!(
        cell.as_str().unwrap_or("").contains("unsupported"),
        "expected a placeholder string, got: {cell}"
    );
}
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/lepetitdev/dev/quarry/src-tauri && cargo test --test exec_test 2>&1 | tail -20
```

Expected: compilation failure — `unresolved import quarry_lib::exec::run_query`.

- [ ] **Step 3: Write the conversion module**

Create `src-tauri/src/exec/value.rs`:

```rust
use postgres_types::{FromSql, Type};
use serde::Serialize;
use serde_json::Value;
use tokio_postgres::Row;

/// Read one cell and turn it into JSON.
///
/// Postgres tells us each column's type at runtime, so this is a lookup
/// table: match the type OID, then read the cell as the matching Rust
/// type. Anything unrecognised becomes a visible placeholder rather
/// than a crash or a silent NULL.
pub fn cell_to_json(row: &Row, idx: usize) -> Value {
    let t = row.columns()[idx].type_();

    // `Type::BOOL` and friends are constants, not enum variants, so they
    // cannot be used in a `match` pattern — hence the if/else chain.
    if t == &Type::BOOL {
        convert::<bool>(row, idx)
    } else if t == &Type::INT2 {
        convert::<i16>(row, idx)
    } else if t == &Type::INT4 {
        convert::<i32>(row, idx)
    } else if t == &Type::INT8 {
        convert::<i64>(row, idx)
    } else if t == &Type::FLOAT4 {
        convert::<f32>(row, idx)
    } else if t == &Type::FLOAT8 {
        convert::<f64>(row, idx)
    } else if t == &Type::NUMERIC {
        // Sent as a string: JSON numbers are f64, which would silently
        // lose precision on a money column.
        match row.try_get::<_, Option<rust_decimal::Decimal>>(idx) {
            Ok(Some(d)) => Value::String(d.to_string()),
            Ok(None) => Value::Null,
            Err(e) => unreadable(e),
        }
    } else if t == &Type::TEXT
        || t == &Type::VARCHAR
        || t == &Type::NAME
        || t == &Type::BPCHAR
    {
        convert::<String>(row, idx)
    } else if t == &Type::JSON || t == &Type::JSONB {
        convert::<Value>(row, idx)
    } else if t == &Type::UUID {
        match row.try_get::<_, Option<uuid::Uuid>>(idx) {
            Ok(Some(u)) => Value::String(u.to_string()),
            Ok(None) => Value::Null,
            Err(e) => unreadable(e),
        }
    } else if t == &Type::DATE {
        match row.try_get::<_, Option<chrono::NaiveDate>>(idx) {
            Ok(Some(d)) => Value::String(d.to_string()),
            Ok(None) => Value::Null,
            Err(e) => unreadable(e),
        }
    } else if t == &Type::TIMESTAMP {
        match row.try_get::<_, Option<chrono::NaiveDateTime>>(idx) {
            Ok(Some(d)) => Value::String(d.format("%Y-%m-%dT%H:%M:%S").to_string()),
            Ok(None) => Value::Null,
            Err(e) => unreadable(e),
        }
    } else if t == &Type::TIMESTAMPTZ {
        match row.try_get::<_, Option<chrono::DateTime<chrono::Utc>>>(idx) {
            Ok(Some(d)) => Value::String(d.to_rfc3339()),
            Ok(None) => Value::Null,
            Err(e) => unreadable(e),
        }
    } else if t == &Type::BYTEA {
        match row.try_get::<_, Option<Vec<u8>>>(idx) {
            Ok(Some(b)) => Value::String(format!("\\x{}", hex(&b))),
            Ok(None) => Value::Null,
            Err(e) => unreadable(e),
        }
    } else {
        Value::String(format!("<unsupported type: {}>", t.name()))
    }
}

/// Read a cell as `T` and serialize it. The `'a` lifetime ties the
/// borrowed row data to the returned value for the duration of the read.
fn convert<'a, T>(row: &'a Row, idx: usize) -> Value
where
    T: FromSql<'a> + Serialize,
{
    match row.try_get::<_, Option<T>>(idx) {
        Ok(Some(v)) => serde_json::to_value(v).unwrap_or(Value::Null),
        Ok(None) => Value::Null,
        Err(e) => unreadable(e),
    }
}

fn unreadable(e: tokio_postgres::Error) -> Value {
    Value::String(format!("<unreadable: {e}>"))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
```

- [ ] **Step 4: Write the execution function**

Create `src-tauri/src/exec/run.rs`:

```rust
use crate::error::AppError;
use crate::exec::value::cell_to_json;
use deadpool_postgres::Pool;
use serde::Serialize;
use std::time::Instant;

/// One column's identity, as shown in the grid header.
#[derive(Debug, Clone, Serialize)]
pub struct ColumnMeta {
    pub name: String,
    pub type_name: String,
}

/// A complete result set. Rows are positional to keep the payload small:
/// column names live once in `columns`, not repeated per row.
#[derive(Debug, Serialize)]
pub struct QueryResult {
    pub columns: Vec<ColumnMeta>,
    pub rows: Vec<Vec<serde_json::Value>>,
    pub row_count: usize,
    pub duration_ms: u64,
}

/// Default ceiling on a single statement, in milliseconds.
const STATEMENT_TIMEOUT_MS: u64 = 30_000;

/// Run one SQL statement and collect every row.
///
/// Stage 3 inserts the safety guard immediately above the `query` call.
/// Stage 1 has no policy enforcement — do not connect this to a
/// production database yet.
pub async fn run_query(pool: &Pool, sql: &str) -> Result<QueryResult, AppError> {
    let client = pool
        .get()
        .await
        .map_err(|e| AppError::Connection(e.to_string()))?;

    // Server-side ceiling: a runaway query is killed by Postgres even if
    // the UI never sends a cancel.
    client
        .batch_execute(&format!("SET statement_timeout = {STATEMENT_TIMEOUT_MS}"))
        .await?;

    let started = Instant::now();
    let rows = client.query(sql, &[]).await?;
    let duration_ms = started.elapsed().as_millis() as u64;

    // Column metadata comes from the first row. An empty result still
    // needs headers, so fall back to preparing the statement.
    let columns: Vec<ColumnMeta> = match rows.first() {
        Some(row) => row
            .columns()
            .iter()
            .map(|c| ColumnMeta {
                name: c.name().to_string(),
                type_name: c.type_().name().to_string(),
            })
            .collect(),
        None => {
            let stmt = client.prepare(sql).await?;
            stmt.columns()
                .iter()
                .map(|c| ColumnMeta {
                    name: c.name().to_string(),
                    type_name: c.type_().name().to_string(),
                })
                .collect()
        }
    };

    let converted: Vec<Vec<serde_json::Value>> = rows
        .iter()
        .map(|row| (0..row.len()).map(|i| cell_to_json(row, i)).collect())
        .collect();

    Ok(QueryResult {
        row_count: converted.len(),
        rows: converted,
        columns,
        duration_ms,
    })
}
```

- [ ] **Step 5: Run tests to verify they pass**

Docker must be running.

```bash
cd /Users/lepetitdev/dev/quarry/src-tauri && cargo test --test exec_test 2>&1 | tail -20
```

Expected: `test result: ok. 5 passed; 0 failed`. The first run pulls the Postgres image and takes a minute.

- [ ] **Step 6: Commit**

```bash
cd /Users/lepetitdev/dev/quarry
git add src-tauri/src/exec src-tauri/tests/exec_test.rs
git commit -m "feat(exec): run queries and convert postgres values to JSON"
```

---

## Task 7: Store passwords in the Keychain

**Files:**
- Create: `src-tauri/src/secrets.rs`

- [ ] **Step 1: Write the failing test**

Create `src-tauri/src/secrets.rs` containing ONLY the test module:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_a_password() {
        let account = format!("test-{}", std::process::id());

        save_password(&account, "hunter2").expect("save should work");
        assert_eq!(load_password(&account).unwrap().as_deref(), Some("hunter2"));

        delete_password(&account).expect("delete should work");
        assert_eq!(load_password(&account).unwrap(), None);
    }

    #[test]
    fn missing_entries_return_none_not_an_error() {
        let account = format!("absent-{}", std::process::id());
        assert_eq!(load_password(&account).unwrap(), None);
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/lepetitdev/dev/quarry/src-tauri && cargo test --lib secrets 2>&1 | tail -10
```

Expected: `cannot find function save_password in this scope`.

- [ ] **Step 3: Write the implementation**

Insert ABOVE the test module in `src-tauri/src/secrets.rs`:

```rust
use crate::error::AppError;
use security_framework::passwords::{
    delete_generic_password, get_generic_password, set_generic_password,
};

/// Keychain service name — groups all of Quarry's entries together, so
/// a user can find and revoke them in Keychain Access.
const SERVICE: &str = "com.quarry.app";

/// Store a password. Overwrites any existing entry for this account.
/// `account` is the connection id, so each connection has one entry.
pub fn save_password(account: &str, password: &str) -> Result<(), AppError> {
    set_generic_password(SERVICE, account, password.as_bytes())
        .map_err(|e| AppError::Keychain(e.to_string()))
}

/// Read a password. A missing entry is `Ok(None)`, not an error — the
/// caller cannot distinguish "no password saved" from "lookup broke"
/// otherwise.
pub fn load_password(account: &str) -> Result<Option<String>, AppError> {
    match get_generic_password(SERVICE, account) {
        Ok(bytes) => {
            let s = String::from_utf8(bytes)
                .map_err(|e| AppError::Keychain(e.to_string()))?;
            Ok(Some(s))
        }
        // Any lookup failure is treated as absence. The Keychain error
        // codes for "not found" vary by macOS version, and a false
        // "not found" degrades to a password prompt rather than a crash.
        Err(_) => Ok(None),
    }
}

/// Remove a password. Deleting something absent is not an error.
pub fn delete_password(account: &str) -> Result<(), AppError> {
    match delete_generic_password(SERVICE, account) {
        Ok(()) => Ok(()),
        Err(_) => Ok(()),
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

macOS may show a Keychain access prompt on the first run — approve it.

```bash
cd /Users/lepetitdev/dev/quarry/src-tauri && cargo test --lib secrets 2>&1 | tail -10
```

Expected: `test result: ok. 2 passed; 0 failed`

- [ ] **Step 5: Commit**

```bash
cd /Users/lepetitdev/dev/quarry
git add src-tauri/src/secrets.rs
git commit -m "feat(secrets): store connection passwords in the macOS Keychain"
```

---

## Task 8: Expose Tauri commands

Commands stay thin: validate, delegate, return. Logic lives in the modules already tested.

**Files:**
- Create: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Write the commands**

Create `src-tauri/src/commands.rs`:

```rust
use crate::conn::{build_pool, ping, ConnectionConfig};
use crate::error::AppError;
use crate::exec::{run_query, QueryResult};
use crate::secrets;
use deadpool_postgres::Pool;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;

/// Live connections, keyed by id. `Mutex` because Tauri calls commands
/// from multiple threads; the lock is held only long enough to clone a
/// pool handle (cloning a Pool is cheap and shares the same sockets).
#[derive(Default)]
pub struct AppState {
    pools: Mutex<HashMap<String, Pool>>,
}

impl AppState {
    fn get(&self, id: &str) -> Result<Pool, AppError> {
        let pools = self.pools.lock().expect("state lock poisoned");
        pools
            .get(id)
            .cloned()
            .ok_or_else(|| AppError::UnknownConnection(id.to_string()))
    }
}

/// What the UI gets back after a successful connect.
#[derive(Serialize)]
pub struct ConnectionInfo {
    pub id: String,
    pub host: String,
    pub port: u16,
    pub dbname: String,
    pub user: String,
    pub server_version: String,
}

#[tauri::command]
pub async fn connect(
    state: tauri::State<'_, AppState>,
    id: String,
    url: String,
    remember_password: bool,
) -> Result<ConnectionInfo, AppError> {
    let cfg = ConnectionConfig::from_url(&url)?;
    let pool = build_pool(&cfg)?;
    let server_version = ping(&pool).await?;

    if remember_password {
        if let Some(pw) = &cfg.password {
            secrets::save_password(&id, pw)?;
        }
    }

    state
        .pools
        .lock()
        .expect("state lock poisoned")
        .insert(id.clone(), pool);

    Ok(ConnectionInfo {
        id,
        host: cfg.host,
        port: cfg.port,
        dbname: cfg.dbname,
        user: cfg.user,
        server_version,
    })
}

#[tauri::command]
pub async fn execute(
    state: tauri::State<'_, AppState>,
    connection_id: String,
    sql: String,
) -> Result<QueryResult, AppError> {
    let pool = state.get(&connection_id)?;
    run_query(&pool, &sql).await
}

#[tauri::command]
pub async fn disconnect(
    state: tauri::State<'_, AppState>,
    connection_id: String,
) -> Result<(), AppError> {
    let removed = state
        .pools
        .lock()
        .expect("state lock poisoned")
        .remove(&connection_id);

    if let Some(pool) = removed {
        pool.close();
    }
    Ok(())
}
```

- [ ] **Step 2: Register state and commands**

Replace the `run` function in `src-tauri/src/lib.rs` with:

```rust
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(commands::AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::connect,
            commands::execute,
            commands::disconnect
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

Delete the scaffold's `greet` command and its registration if present.

- [ ] **Step 3: Verify the whole crate compiles and all tests pass**

```bash
cd /Users/lepetitdev/dev/quarry/src-tauri && cargo test 2>&1 | tail -25
```

Expected: every test suite reports `ok`, zero failures.

- [ ] **Step 4: Commit**

```bash
cd /Users/lepetitdev/dev/quarry
git add src-tauri/src
git commit -m "feat(ipc): expose connect, execute, and disconnect commands"
```

---

## Task 9: TypeScript IPC layer and cell formatting

**Files:**
- Create: `src/types.ts`, `src/lib/ipc.ts`, `src/lib/format.ts`, `src/lib/format.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Add frontend dependencies**

```bash
cd /Users/lepetitdev/dev/quarry
npm install @tanstack/react-virtual @uiw/react-codemirror @codemirror/lang-sql
npm install -D vitest
```

- [ ] **Step 2: Add the test script**

In `package.json`, add to `"scripts"`:

```json
"test": "vitest run"
```

- [ ] **Step 3: Write the failing formatting tests**

Create `src/lib/format.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { formatCell } from "./format";

describe("formatCell", () => {
  it("renders null distinctly from an empty string", () => {
    expect(formatCell(null)).toEqual({ text: "NULL", kind: "null" });
    expect(formatCell("")).toEqual({ text: "", kind: "text" });
  });

  it("renders booleans as lowercase literals", () => {
    expect(formatCell(true)).toEqual({ text: "true", kind: "bool" });
    expect(formatCell(false)).toEqual({ text: "false", kind: "bool" });
  });

  it("renders numbers without locale separators", () => {
    expect(formatCell(1234567)).toEqual({ text: "1234567", kind: "number" });
  });

  it("collapses objects and arrays to single-line JSON", () => {
    expect(formatCell({ k: 1 })).toEqual({ text: '{"k":1}', kind: "json" });
    expect(formatCell([1, 2])).toEqual({ text: "[1,2]", kind: "json" });
  });

  it("passes strings through untouched", () => {
    expect(formatCell("hello")).toEqual({ text: "hello", kind: "text" });
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

```bash
cd /Users/lepetitdev/dev/quarry && npm test 2>&1 | tail -10
```

Expected: failure — cannot resolve `./format`.

- [ ] **Step 5: Write the types, IPC wrappers, and formatter**

Create `src/types.ts`:

```typescript
/** Mirrors Rust `ColumnMeta`. */
export interface ColumnMeta {
  name: string;
  type_name: string;
}

/** Mirrors Rust `QueryResult`. Rows are positional, matching `columns`. */
export interface QueryResult {
  columns: ColumnMeta[];
  rows: CellValue[][];
  row_count: number;
  duration_ms: number;
}

export type CellValue =
  | string
  | number
  | boolean
  | null
  | Record<string, unknown>
  | unknown[];

/** Mirrors Rust `ConnectionInfo`. */
export interface ConnectionInfo {
  id: string;
  host: string;
  port: number;
  dbname: string;
  user: string;
  server_version: string;
}

/** Mirrors Rust `ErrorPayload`. */
export interface AppErrorPayload {
  kind:
    | "invalid_url"
    | "connection"
    | "unknown_connection"
    | "query"
    | "keychain";
  message: string;
  code: string | null;
  position: number | null;
}
```

Create `src/lib/ipc.ts`:

```typescript
import { invoke } from "@tauri-apps/api/core";
import type { AppErrorPayload, ConnectionInfo, QueryResult } from "../types";

/**
 * The only module that talks to Tauri. Everything else imports these
 * functions, so the IPC surface stays visible in one place.
 */

export async function connect(
  id: string,
  url: string,
  rememberPassword: boolean,
): Promise<ConnectionInfo> {
  return invoke<ConnectionInfo>("connect", {
    id,
    url,
    rememberPassword,
  });
}

export async function execute(
  connectionId: string,
  sql: string,
): Promise<QueryResult> {
  return invoke<QueryResult>("execute", { connectionId, sql });
}

export async function disconnect(connectionId: string): Promise<void> {
  return invoke("disconnect", { connectionId });
}

/** Narrow an unknown thrown value to our error shape. */
export function asAppError(e: unknown): AppErrorPayload {
  if (
    typeof e === "object" &&
    e !== null &&
    "kind" in e &&
    "message" in e
  ) {
    return e as AppErrorPayload;
  }
  return {
    kind: "connection",
    message: String(e),
    code: null,
    position: null,
  };
}
```

Create `src/lib/format.ts`:

```typescript
import type { CellValue } from "../types";

export type CellKind = "null" | "bool" | "number" | "json" | "text";

export interface FormattedCell {
  text: string;
  kind: CellKind;
}

/**
 * Turn a raw cell into display text plus a kind used for styling.
 *
 * The null/empty-string distinction matters: a grid that renders both
 * as blank makes it impossible to tell a missing value from a present
 * one, which changes what query you write next.
 */
export function formatCell(value: CellValue): FormattedCell {
  if (value === null) return { text: "NULL", kind: "null" };
  if (typeof value === "boolean") {
    return { text: value ? "true" : "false", kind: "bool" };
  }
  if (typeof value === "number") return { text: String(value), kind: "number" };
  if (typeof value === "object") {
    return { text: JSON.stringify(value), kind: "json" };
  }
  return { text: value, kind: "text" };
}
```

- [ ] **Step 6: Run tests to verify they pass**

```bash
cd /Users/lepetitdev/dev/quarry && npm test 2>&1 | tail -10
```

Expected: `Test Files 1 passed`, `Tests 5 passed`

- [ ] **Step 7: Commit**

```bash
cd /Users/lepetitdev/dev/quarry
git add src package.json package-lock.json
git commit -m "feat(ui): add typed IPC layer and cell formatting"
```

---

## Task 10: Connection form

**Files:**
- Create: `src/components/ConnectionForm.tsx`

- [ ] **Step 1: Write the component**

Create `src/components/ConnectionForm.tsx`:

```tsx
import { useState } from "react";
import { asAppError, connect } from "../lib/ipc";
import type { ConnectionInfo } from "../types";

interface Props {
  onConnected: (info: ConnectionInfo) => void;
}

export function ConnectionForm({ onConnected }: Props) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConnect(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // One connection in Stage 1; Stage 2 introduces saved connections
      // with real ids.
      const info = await connect("default", url, true);
      onConnected(info);
    } catch (e) {
      setError(asAppError(e).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="connection-form" onSubmit={handleConnect}>
      <label htmlFor="url">Connection URL</label>
      <input
        id="url"
        type="text"
        placeholder="postgres://user:password@localhost:5432/dbname"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        autoFocus
        spellCheck={false}
      />
      <button type="submit" disabled={busy || url.trim() === ""}>
        {busy ? "Connecting…" : "Connect"}
      </button>
      {error && <p className="error">{error}</p>}
    </form>
  );
}
```

- [ ] **Step 2: Commit**

```bash
cd /Users/lepetitdev/dev/quarry
git add src/components/ConnectionForm.tsx
git commit -m "feat(ui): add connection form"
```

---

## Task 11: SQL editor

**Files:**
- Create: `src/components/SqlEditor.tsx`

- [ ] **Step 1: Write the component**

Create `src/components/SqlEditor.tsx`:

```tsx
import CodeMirror from "@uiw/react-codemirror";
import { sql, PostgreSQL } from "@codemirror/lang-sql";
import { keymap } from "@codemirror/view";
import { Prec } from "@codemirror/state";
import { useMemo } from "react";

interface Props {
  value: string;
  onChange: (value: string) => void;
  onRun: () => void;
  busy: boolean;
}

export function SqlEditor({ value, onChange, onRun, busy }: Props) {
  // Prec.highest ensures Cmd+Enter reaches us before CodeMirror's own
  // bindings. useMemo keeps the extension array stable across renders,
  // which stops CodeMirror from tearing down its state on every keystroke.
  const extensions = useMemo(
    () => [
      sql({ dialect: PostgreSQL }),
      Prec.highest(
        keymap.of([
          {
            key: "Mod-Enter",
            run: () => {
              onRun();
              return true;
            },
          },
        ]),
      ),
    ],
    [onRun],
  );

  return (
    <div className="sql-editor">
      <CodeMirror
        value={value}
        height="200px"
        extensions={extensions}
        onChange={onChange}
      />
      <div className="editor-toolbar">
        <button onClick={onRun} disabled={busy}>
          {busy ? "Running…" : "Run  ⌘↵"}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
cd /Users/lepetitdev/dev/quarry
git add src/components/SqlEditor.tsx
git commit -m "feat(ui): add CodeMirror SQL editor with Cmd+Enter to run"
```

---

## Task 12: Virtualized result grid

**Files:**
- Create: `src/components/ResultGrid.tsx`, `src/components/StatusBar.tsx`

- [ ] **Step 1: Write the grid**

Create `src/components/ResultGrid.tsx`:

```tsx
import { useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { formatCell } from "../lib/format";
import type { QueryResult } from "../types";

interface Props {
  result: QueryResult;
}

const ROW_HEIGHT = 28;

export function ResultGrid({ result }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Only the visible rows are mounted. Without this a 100k-row result
  // creates 100k DOM nodes and the window stops responding.
  const virtualizer = useVirtualizer({
    count: result.rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  if (result.columns.length === 0) {
    return <div className="grid-empty">Statement returned no columns.</div>;
  }

  return (
    <div className="result-grid" ref={scrollRef}>
      <table>
        <thead>
          <tr>
            {result.columns.map((c) => (
              <th key={c.name} title={c.type_name}>
                {c.name}
                <span className="col-type">{c.type_name}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody style={{ height: `${virtualizer.getTotalSize()}px` }}>
          {virtualizer.getVirtualItems().map((item) => {
            const row = result.rows[item.index];
            return (
              <tr
                key={item.key}
                style={{
                  position: "absolute",
                  transform: `translateY(${item.start}px)`,
                  height: `${ROW_HEIGHT}px`,
                }}
              >
                {row.map((cell, i) => {
                  const { text, kind } = formatCell(cell);
                  return (
                    <td key={i} className={`cell-${kind}`} title={text}>
                      {text}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 2: Write the status bar**

Create `src/components/StatusBar.tsx`:

```tsx
import type { AppErrorPayload, QueryResult } from "../types";

interface Props {
  result: QueryResult | null;
  error: AppErrorPayload | null;
}

export function StatusBar({ result, error }: Props) {
  if (error) {
    return (
      <div className="status-bar error">
        {error.code && <span className="sqlstate">{error.code}</span>}
        <span>{error.message}</span>
        {error.position !== null && (
          <span className="position">at character {error.position}</span>
        )}
      </div>
    );
  }

  if (!result) {
    return <div className="status-bar">Ready</div>;
  }

  return (
    <div className="status-bar">
      {result.row_count} {result.row_count === 1 ? "row" : "rows"} ·{" "}
      {result.duration_ms} ms
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
cd /Users/lepetitdev/dev/quarry
git add src/components/ResultGrid.tsx src/components/StatusBar.tsx
git commit -m "feat(ui): add virtualized result grid and status bar"
```

---

## Task 13: Compose the app and style it

**Files:**
- Modify: `src/App.tsx`, `src/App.css`

- [ ] **Step 1: Write App.tsx**

Replace the entire contents of `src/App.tsx`:

```tsx
import { useCallback, useState } from "react";
import { ConnectionForm } from "./components/ConnectionForm";
import { ResultGrid } from "./components/ResultGrid";
import { SqlEditor } from "./components/SqlEditor";
import { StatusBar } from "./components/StatusBar";
import { asAppError, execute } from "./lib/ipc";
import type { AppErrorPayload, ConnectionInfo, QueryResult } from "./types";
import "./App.css";

export default function App() {
  const [connection, setConnection] = useState<ConnectionInfo | null>(null);
  const [sql, setSql] = useState("select 1;");
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<AppErrorPayload | null>(null);
  const [busy, setBusy] = useState(false);

  // useCallback keeps this stable so SqlEditor's keymap is not rebuilt
  // on every render.
  const run = useCallback(async () => {
    if (!connection) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await execute(connection.id, sql));
    } catch (e) {
      setError(asAppError(e));
      setResult(null);
    } finally {
      setBusy(false);
    }
  }, [connection, sql]);

  if (!connection) {
    return (
      <main className="app centered">
        <h1>Quarry</h1>
        <ConnectionForm onConnected={setConnection} />
      </main>
    );
  }

  return (
    <main className="app">
      <header className="top-bar">
        <strong>
          {connection.user}@{connection.host}:{connection.port}/
          {connection.dbname}
        </strong>
      </header>
      <SqlEditor value={sql} onChange={setSql} onRun={run} busy={busy} />
      {result && <ResultGrid result={result} />}
      <StatusBar result={result} error={error} />
    </main>
  );
}
```

- [ ] **Step 2: Write App.css**

Replace the entire contents of `src/App.css`:

```css
:root {
  --bg: #16181d;
  --panel: #1d2027;
  --border: #2c3038;
  --text: #e5e7eb;
  --muted: #8b93a1;
  --accent: #4f8ef7;
  --error: #f26d6d;
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
  font-size: 13px;
}

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
}

.app {
  display: flex;
  flex-direction: column;
  height: 100vh;
}

.app.centered {
  align-items: center;
  justify-content: center;
  gap: 16px;
}

.top-bar {
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--panel);
}

.connection-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 460px;
}

.connection-form input {
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel);
  color: var(--text);
  font-family: ui-monospace, "SF Mono", monospace;
}

button {
  padding: 6px 14px;
  border: none;
  border-radius: 6px;
  background: var(--accent);
  color: white;
  font-weight: 500;
}

button:disabled {
  opacity: 0.5;
}

.editor-toolbar {
  display: flex;
  justify-content: flex-end;
  padding: 6px;
  border-bottom: 1px solid var(--border);
}

.result-grid {
  flex: 1;
  overflow: auto;
  position: relative;
}

.result-grid table {
  border-collapse: collapse;
  width: 100%;
  table-layout: fixed;
}

/* Virtualized rows are absolutely positioned, which takes them out of
   the table's own column sizing. Forcing each row to lay out as its own
   fixed table keeps the columns aligned with the header. */
.result-grid thead,
.result-grid tbody tr {
  display: table;
  width: 100%;
  table-layout: fixed;
}

.result-grid thead th {
  position: sticky;
  top: 0;
  z-index: 1;
  text-align: left;
  padding: 6px 10px;
  background: var(--panel);
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
}

.col-type {
  margin-left: 6px;
  color: var(--muted);
  font-weight: 400;
}

.result-grid tbody {
  position: relative;
  display: block;
}

.result-grid td {
  padding: 4px 10px;
  border-bottom: 1px solid var(--border);
  font-family: ui-monospace, "SF Mono", monospace;
  white-space: nowrap;
  max-width: 340px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.cell-null {
  color: var(--muted);
  font-style: italic;
}

.cell-number {
  text-align: right;
}

.status-bar {
  padding: 6px 12px;
  border-top: 1px solid var(--border);
  background: var(--panel);
  color: var(--muted);
}

.status-bar.error {
  color: var(--error);
}

.sqlstate {
  margin-right: 8px;
  font-family: ui-monospace, monospace;
}

.error {
  color: var(--error);
}
```

- [ ] **Step 3: Verify the frontend compiles**

```bash
cd /Users/lepetitdev/dev/quarry && npx tsc --noEmit 2>&1 | head -20
```

Expected: no output (clean).

- [ ] **Step 4: Commit**

```bash
cd /Users/lepetitdev/dev/quarry
git add src
git commit -m "feat(ui): compose app shell and styling"
```

---

## Task 14: End-to-end smoke test

Verifies the whole path against a real database, by hand, in the real app.

**Files:** none

- [ ] **Step 1: Start a scratch Postgres with data**

```bash
docker run --rm -d --name quarry-smoke -e POSTGRES_PASSWORD=postgres -p 55432:5432 postgres:17
sleep 4
docker exec quarry-smoke psql -U postgres -c "create table users (id serial primary key, email text, plan text, active bool, meta jsonb, created_at timestamp default now());"
docker exec quarry-smoke psql -U postgres -c "insert into users (email, plan, active, meta) select 'user'||g||'@example.com', case when g%3=0 then 'pro' else 'free' end, g%2=0, jsonb_build_object('n', g) from generate_series(1,50000) g;"
docker exec quarry-smoke psql -U postgres -c "insert into users (email, plan) values ('', 'edge'), (null, 'edge');"
```

- [ ] **Step 2: Run the app**

```bash
cd /Users/lepetitdev/dev/quarry && npm run tauri dev
```

- [ ] **Step 3: Verify each behavior**

Connect with `postgres://postgres:postgres@localhost:55432/postgres?sslmode=disable`, then check:

- [ ] Connecting succeeds and the header shows `postgres@localhost:55432/postgres`
- [ ] `select * from users limit 100` returns rows; ⌘↵ runs it
- [ ] `select * from users` (50k rows) scrolls smoothly, no freeze
- [ ] The `email` column shows `NULL` in grey italic for one row and an empty cell for another — they look different
- [ ] `meta` renders as `{"n":1}` JSON text
- [ ] `select * from nope` shows the error with SQLSTATE `42P01` in the status bar
- [ ] `select 1 where false` shows a header row, 0 rows, no error
- [ ] Quitting and reopening the app requires reconnecting (expected — persistence is Stage 2)

- [ ] **Step 4: Tear down**

```bash
docker stop quarry-smoke
```

- [ ] **Step 5: Run the full test suite one final time**

```bash
cd /Users/lepetitdev/dev/quarry && npm test && cd src-tauri && cargo test 2>&1 | tail -20
```

Expected: all TS and Rust tests pass.

- [ ] **Step 6: Tag the stage**

```bash
cd /Users/lepetitdev/dev/quarry
git tag stage-1-connect-run-grid
git log --oneline | head -15
```

---

## Definition of done

- Connect to Postgres from a pasted URL; bad URLs and unreachable hosts produce readable errors
- Run arbitrary SQL; results render in a grid that stays responsive at 50k rows
- NULL is visually distinct from an empty string
- Postgres errors surface with SQLSTATE and character position
- Passwords are stored in the Keychain, never on disk in plaintext
- `cargo test` and `npm test` both pass
- Every Rust module has a single responsibility and its own tests

## Deliberately not in this stage

Saved queries, tabs, persistence (Stage 2). Environments, variables, and the safety guard (Stage 3) — **so do not point this build at a production database.** Schema tree and autocomplete (Stage 4). History, command palette, export (Stage 5). Inline row editing (Stage 6). Query cancellation ships with Stage 3 alongside the guard; Stage 1 relies on the server-side `statement_timeout` alone.
