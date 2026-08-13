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
        // Widen to f64 before serializing: serializing an f32 directly
        // and letting serde_json print its shortest round-trip
        // representation can disagree with how `json!(1.5)` (an f64
        // literal) gets printed/compared, so go through f64 explicitly.
        match row.try_get::<_, Option<f32>>(idx) {
            Ok(Some(v)) => serde_json::to_value(f64::from(v)).unwrap_or(Value::Null),
            Ok(None) => Value::Null,
            Err(e) => unreadable(e),
        }
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
            Ok(Some(d)) => Value::String(d.format("%Y-%m-%dT%H:%M:%S%.f").to_string()),
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
