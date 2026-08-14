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
            Ok(Some(v)) => float_to_json(f64::from(v)),
            Ok(None) => Value::Null,
            Err(e) => unreadable(e),
        }
    } else if t == &Type::FLOAT8 {
        match row.try_get::<_, Option<f64>>(idx) {
            Ok(Some(v)) => float_to_json(v),
            Ok(None) => Value::Null,
            Err(e) => unreadable(e),
        }
    } else if t == &Type::NUMERIC {
        // Sent as a string, for two reasons: JSON numbers are f64,
        // which would silently lose precision on a money column, and
        // Postgres NUMERIC is arbitrary-precision with a NaN value,
        // neither of which any Rust numeric type can represent — so
        // this decodes the wire format directly rather than going
        // through a fixed-width intermediate type.
        match row.try_get::<_, Option<PgNumeric>>(idx) {
            Ok(Some(PgNumeric(s))) => Value::String(s),
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
    } else if let Some(array) = array_to_json(row, idx, t) {
        array
    } else if t.name() != "record" && !matches!(t.kind(), postgres_types::Kind::Array(_)) {
        // Last resort: enums and other text-shaped types whose OID we do
        // not know. Anything that is not valid UTF-8 falls through to the
        // placeholder below rather than becoming a silent null.
        //
        // Array types are excluded here even when `array_to_json` above
        // could not decode them (multi-dimensional arrays, or an array of
        // an element type we do not otherwise render): their wire format
        // is binary, not text, and low integer bytes like `{{1,2},{3,4}}`
        // happen to be valid UTF-8, so AnyText would silently turn them
        // into mojibake instead of falling through to the placeholder.
        match row.try_get::<_, Option<AnyText>>(idx) {
            Ok(Some(AnyText(s))) => Value::String(s),
            Ok(None) => Value::Null,
            Err(_) => Value::String(format!("<unsupported type: {}>", t.name())),
        }
    } else {
        Value::String(format!("<unsupported type: {}>", t.name()))
    }
}

/// Decode a one-dimensional array of `T` into a JSON array.
///
/// `Vec<Option<T>>` because array elements can individually be NULL —
/// `{1,NULL,3}` is a perfectly ordinary Postgres value.
fn convert_array<'a, T>(row: &'a Row, idx: usize) -> Option<Value>
where
    T: FromSql<'a> + Serialize,
{
    match row.try_get::<_, Option<Vec<Option<T>>>>(idx) {
        Ok(Some(items)) => {
            let json: Vec<Value> = items
                .into_iter()
                .map(|item| match item {
                    Some(v) => serde_json::to_value(v).unwrap_or(Value::Null),
                    None => Value::Null,
                })
                .collect();
            Some(Value::Array(json))
        }
        Ok(None) => Some(Value::Null),
        // A multi-dimensional array fails to decode as a flat Vec. Fall
        // through to the placeholder rather than inventing a shape.
        Err(_) => None,
    }
}

/// Reads any type's bytes as UTF-8, whatever its OID.
///
/// This exists for enums: their wire representation is simply the label
/// text, but `String`'s `FromSql` refuses unknown OIDs, so the normal
/// path cannot read them. Used only as a last resort, after every known
/// type has been tried.
#[derive(Debug)]
struct AnyText(String);

impl<'a> FromSql<'a> for AnyText {
    fn from_sql(
        _ty: &Type,
        raw: &'a [u8],
    ) -> Result<Self, Box<dyn std::error::Error + Sync + Send>> {
        Ok(AnyText(std::str::from_utf8(raw)?.to_string()))
    }

    fn accepts(_ty: &Type) -> bool {
        true
    }
}

/// Dispatch on element type for the array types we render.
///
/// Returns `None` for arrays we cannot decode — including
/// multi-dimensional ones — so the caller falls back to a placeholder.
fn array_to_json(row: &Row, idx: usize, t: &Type) -> Option<Value> {
    if t == &Type::INT2_ARRAY {
        convert_array::<i16>(row, idx)
    } else if t == &Type::INT4_ARRAY {
        convert_array::<i32>(row, idx)
    } else if t == &Type::INT8_ARRAY {
        convert_array::<i64>(row, idx)
    } else if t == &Type::FLOAT4_ARRAY {
        convert_array::<f32>(row, idx)
    } else if t == &Type::FLOAT8_ARRAY {
        convert_array::<f64>(row, idx)
    } else if t == &Type::BOOL_ARRAY {
        convert_array::<bool>(row, idx)
    } else if t == &Type::TEXT_ARRAY
        || t == &Type::VARCHAR_ARRAY
        || t == &Type::NAME_ARRAY
        || t == &Type::BPCHAR_ARRAY
    {
        convert_array::<String>(row, idx)
    } else if t == &Type::UUID_ARRAY {
        match row.try_get::<_, Option<Vec<Option<uuid::Uuid>>>>(idx) {
            Ok(Some(items)) => Some(Value::Array(
                items
                    .into_iter()
                    .map(|i| match i {
                        Some(u) => Value::String(u.to_string()),
                        None => Value::Null,
                    })
                    .collect(),
            )),
            Ok(None) => Some(Value::Null),
            Err(_) => None,
        }
    } else if t == &Type::JSON_ARRAY || t == &Type::JSONB_ARRAY {
        convert_array::<Value>(row, idx)
    } else {
        None
    }
}

/// Turn a float into JSON, representing non-finite values as strings.
///
/// `serde_json::to_value(f64::NAN)` (and +/-infinity) returns `Err`,
/// because JSON has no literal for them. Piping that through
/// `.unwrap_or(Value::Null)` — the naive fix — makes a real `NaN` cell
/// indistinguishable from a SQL `NULL`. Emitting the IEEE 754 name as a
/// string keeps the two visibly different.
fn float_to_json(v: f64) -> Value {
    if v.is_nan() {
        Value::String("NaN".to_string())
    } else if v.is_infinite() {
        Value::String(if v > 0.0 { "Infinity" } else { "-Infinity" }.to_string())
    } else {
        serde_json::to_value(v).unwrap_or(Value::Null)
    }
}

/// A decoded Postgres NUMERIC, kept as its base-10 string form.
///
/// `rust_decimal::Decimal` is 96-bit (~28 significant digits) and has
/// no NaN, so it fails to decode a 40-digit NUMERIC or `'NaN'::numeric`
/// — both valid, arbitrary-precision Postgres values. This decodes the
/// wire binary format directly instead, so it can represent anything
/// Postgres can send.
struct PgNumeric(String);

impl<'a> FromSql<'a> for PgNumeric {
    fn from_sql(
        _ty: &Type,
        raw: &'a [u8],
    ) -> Result<Self, Box<dyn std::error::Error + Sync + Send>> {
        decode_numeric(raw).map(PgNumeric)
    }

    fn accepts(ty: &Type) -> bool {
        matches!(*ty, Type::NUMERIC)
    }
}

/// Decode the Postgres NUMERIC binary wire format into a base-10
/// string.
///
/// Wire layout (network byte order), per `numeric_send`/`numeric_recv`
/// in the Postgres backend:
///   ndigits: i16   — count of base-10000 digit groups that follow
///   weight:  i16   — power-of-10000 place of the first digit group
///   sign:    u16   — 0x0000 positive, 0x4000 negative, 0xC000 NaN,
///                    0xD000 +Infinity, 0xF000 -Infinity (PG14+)
///   dscale:  u16   — number of decimal digits to display after '.'
///   digits:  [i16; ndigits] — each in 0..=9999
fn decode_numeric(raw: &[u8]) -> Result<String, Box<dyn std::error::Error + Sync + Send>> {
    if raw.len() < 8 {
        return Err("invalid numeric: header too short".into());
    }
    let ndigits = i16::from_be_bytes([raw[0], raw[1]]);
    let weight = i16::from_be_bytes([raw[2], raw[3]]) as i32;
    let sign = u16::from_be_bytes([raw[4], raw[5]]);
    let dscale = u16::from_be_bytes([raw[6], raw[7]]);

    match sign {
        0xC000 => return Ok("NaN".to_string()),
        0xD000 => return Ok("Infinity".to_string()),
        0xF000 => return Ok("-Infinity".to_string()),
        _ => {}
    }

    let mut digits = Vec::with_capacity(ndigits.max(0) as usize);
    let mut pos = 8usize;
    for _ in 0..ndigits {
        if pos + 2 > raw.len() {
            return Err("invalid numeric: truncated digit list".into());
        }
        digits.push(i16::from_be_bytes([raw[pos], raw[pos + 1]]) as i32);
        pos += 2;
    }

    // digit_at(exp) is the base-10000 digit at the 10000^exp place, or
    // 0 if that place falls outside what was actually sent (Postgres
    // omits trailing/leading zero digit groups).
    let digit_at = |exp: i32| -> i32 {
        let k = weight - exp;
        if k >= 0 && (k as usize) < digits.len() {
            digits[k as usize]
        } else {
            0
        }
    };

    let mut s = String::new();
    if sign == 0x4000 {
        s.push('-');
    }

    if ndigits == 0 || weight < 0 {
        s.push('0');
    } else {
        for (i, exp) in (0..=weight).rev().enumerate() {
            if i == 0 {
                s.push_str(&digit_at(exp).to_string());
            } else {
                s.push_str(&format!("{:04}", digit_at(exp)));
            }
        }
    }

    if dscale > 0 {
        s.push('.');
        let groups = (dscale as usize).div_ceil(4);
        let mut frac = String::new();
        for i in 0..groups {
            let exp = -1 - i as i32;
            frac.push_str(&format!("{:04}", digit_at(exp)));
        }
        frac.truncate(dscale as usize);
        s.push_str(&frac);
    }

    Ok(s)
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

#[cfg(test)]
mod tests {
    use super::decode_numeric;

    /// Build the NUMERIC wire format by hand: header fields plus a list
    /// of base-10000 digit groups, matching `numeric_send`.
    fn numeric_bytes(ndigits: i16, weight: i16, sign: u16, dscale: u16, digits: &[i16]) -> Vec<u8> {
        let mut buf = Vec::new();
        buf.extend_from_slice(&ndigits.to_be_bytes());
        buf.extend_from_slice(&weight.to_be_bytes());
        buf.extend_from_slice(&sign.to_be_bytes());
        buf.extend_from_slice(&dscale.to_be_bytes());
        for d in digits {
            buf.extend_from_slice(&d.to_be_bytes());
        }
        buf
    }

    #[test]
    fn decodes_zero() {
        let bytes = numeric_bytes(0, 0, 0x0000, 0, &[]);
        assert_eq!(decode_numeric(&bytes).unwrap(), "0");
    }

    #[test]
    fn decodes_a_positive_integer() {
        let bytes = numeric_bytes(1, 0, 0x0000, 0, &[42]);
        assert_eq!(decode_numeric(&bytes).unwrap(), "42");
    }

    #[test]
    fn decodes_a_negative_integer() {
        let bytes = numeric_bytes(1, 0, 0x4000, 0, &[42]);
        assert_eq!(decode_numeric(&bytes).unwrap(), "-42");
    }

    #[test]
    fn decodes_a_fractional_value() {
        // 12.34: integer digit group 12 (weight 0), fractional group
        // 3400 (weight -1), display scale 2.
        let bytes = numeric_bytes(2, 0, 0x0000, 2, &[12, 3400]);
        assert_eq!(decode_numeric(&bytes).unwrap(), "12.34");
    }

    #[test]
    fn decodes_a_value_smaller_than_one() {
        // 0.001234: first digit group is at weight -1 (value 12),
        // second at weight -2 (value 3400), display scale 6.
        let bytes = numeric_bytes(2, -1, 0x0000, 6, &[12, 3400]);
        assert_eq!(decode_numeric(&bytes).unwrap(), "0.001234");
    }

    #[test]
    fn decodes_nan() {
        let bytes = numeric_bytes(0, 0, 0xC000, 0, &[]);
        assert_eq!(decode_numeric(&bytes).unwrap(), "NaN");
    }

    #[test]
    fn decodes_positive_infinity() {
        let bytes = numeric_bytes(0, 0, 0xD000, 0, &[]);
        assert_eq!(decode_numeric(&bytes).unwrap(), "Infinity");
    }

    #[test]
    fn decodes_negative_infinity() {
        let bytes = numeric_bytes(0, 0, 0xF000, 0, &[]);
        assert_eq!(decode_numeric(&bytes).unwrap(), "-Infinity");
    }
}
