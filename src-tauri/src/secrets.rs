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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_a_password() {
        let account = format!("test-{}", std::process::id());

        let result = (|| {
            save_password(&account, "hunter2").expect("save should work");
            assert_eq!(load_password(&account).unwrap().as_deref(), Some("hunter2"));
            Ok::<(), ()>(())
        })();

        delete_password(&account).expect("delete should work");
        assert_eq!(load_password(&account).unwrap(), None);

        result.expect("body should succeed");
    }

    #[test]
    fn missing_entries_return_none_not_an_error() {
        let account = format!("absent-{}", std::process::id());
        assert_eq!(load_password(&account).unwrap(), None);
    }
}
