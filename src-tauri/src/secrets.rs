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

/// The OSStatus for "no matching Keychain item" (`errSecItemNotFound`
/// in Security/SecBase.h). `security-framework` re-exports it from its
/// `-sys` crate rather than as a public constant on `Error`, and that
/// `-sys` crate is only a transitive dependency here, so we can't name
/// it directly — hence the literal, with the name in a comment so it
/// stays greppable.
const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;

/// Read a password. A missing entry is `Ok(None)`, not an error — the
/// caller cannot distinguish "no password saved" from "lookup broke"
/// otherwise.
///
/// This used to fail-open on every error, including a locked or
/// otherwise unreadable Keychain, on the theory that degrading to a
/// password prompt was safer than surfacing a Keychain error. In
/// practice that swallowed real failures: `tauri dev` re-signs the
/// binary on every rebuild, and macOS scopes Keychain items to the
/// signing identity that created them, so a rebuilt dev binary can lose
/// access to entries it saved moments earlier. Collapsing that to
/// `Ok(None)` sent `connect_saved` down the no-password path even for
/// connections that need one, and the resulting driver error ("invalid
/// configuration") named neither the Keychain nor the fix. Now only
/// `errSecItemNotFound` — genuinely no entry for this account — maps to
/// `Ok(None)`; every other failure is a real, actionable condition and
/// is surfaced as `Err`.
pub fn load_password(account: &str) -> Result<Option<String>, AppError> {
    match get_generic_password(SERVICE, account) {
        Ok(bytes) => {
            let s = String::from_utf8(bytes)
                .map_err(|e| AppError::Keychain(e.to_string()))?;
            Ok(Some(s))
        }
        // errSecItemNotFound: nothing saved under this account, which
        // is a normal state, not a failure.
        Err(e) if e.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(None),
        // Any other error means the lookup itself broke (locked or
        // inaccessible Keychain, wrong signing identity, etc.) — report
        // it rather than pretending there's no password.
        Err(e) => Err(AppError::Keychain(e.to_string())),
    }
}

/// Remove a password. Deleting something already absent is success —
/// the end state the caller wants ("no password stored") already
/// holds. Any *other* failure (e.g. a locked Keychain, a permission
/// denial) is surfaced as `Err` rather than swallowed: silently
/// reporting success on a deletion that didn't actually happen would
/// leave a credential in the Keychain while the app claims it's gone,
/// which is a lie the caller needs to know about, not a convenience
/// default.
pub fn delete_password(account: &str) -> Result<(), AppError> {
    match delete_generic_password(SERVICE, account) {
        Ok(()) => Ok(()),
        // errSecItemNotFound: nothing to delete, so the caller's goal
        // (no password stored under this account) is already met.
        Err(e) if e.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(()),
        // Any other error is a real failure to remove the credential —
        // report it rather than pretending the deletion succeeded.
        Err(e) => Err(AppError::Keychain(e.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Deletes its Keychain entry when dropped, so a test that panics
    /// mid-assertion still cleans up rather than leaving a real entry
    /// behind. `expect`/`assert!` unwind past any ordinary cleanup code
    /// written after them — a `Drop` impl is the one thing that still
    /// runs during that unwind.
    struct CleansUpOnDrop<'a>(&'a str);

    impl Drop for CleansUpOnDrop<'_> {
        fn drop(&mut self) {
            let _ = delete_password(self.0);
        }
    }

    #[test]
    fn round_trips_a_password() {
        let account = format!("test-{}", std::process::id());
        // Cleans up even if an assertion below panics; the explicit
        // delete_password call further down still exercises deletion
        // as part of the round trip itself.
        let _guard = CleansUpOnDrop(&account);

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

    #[test]
    fn deleting_an_absent_password_is_not_an_error() {
        let account = format!("never-existed-{}", std::process::id());
        assert!(delete_password(&account).is_ok());
    }
}
