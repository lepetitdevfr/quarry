use crate::error::AppError;

/// Keychain service name — groups all of Quarry's entries together, so
/// a user can find and revoke them in Keychain Access.
const SERVICE: &str = "com.quarry.app";

/// The platform credential store, behind three functions.
///
/// macOS does not go through `keyring` even though `keyring` supports
/// it. Its macOS backend calls `find_generic_password` with an explicit
/// `SecKeychain`, and passing one makes macOS authorise the keychain and
/// the item as two separate operations — two prompts for one read,
/// which was measured, not assumed. `security_framework::passwords` uses
/// the modern `SecItem` API and asks once.
///
/// This is the second `cfg(target_os)` in the codebase and it is here
/// for a user-visible reason, not a portability one: every platform
/// still gets the same three functions.
#[cfg(target_os = "macos")]
mod backend {
    use super::{AppError, SERVICE};
    use security_framework::passwords::{
        delete_generic_password, get_generic_password, set_generic_password,
    };

    /// `errSecItemNotFound` — nothing saved under this account.
    const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;
    /// `errSecAuthFailed` — the entry exists, but this process may not
    /// read it, typically because the binary's signature changed.
    const ERR_SEC_AUTH_FAILED: i32 = -25293;

    pub fn get(account: &str) -> Result<Option<String>, AppError> {
        match get_generic_password(SERVICE, account) {
            Ok(bytes) => String::from_utf8(bytes)
                .map(Some)
                .map_err(|e| AppError::Keychain(e.to_string())),
            Err(e) if e.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(None),
            // macOS words this one as "The user name or passphrase you
            // entered is not correct", which sounds like a database
            // credential problem and sends people looking in entirely
            // the wrong place. Say what it is and what fixes it.
            Err(e) if e.code() == ERR_SEC_AUTH_FAILED => Err(AppError::Keychain(
                "macOS denied access to the saved password. This happens after \
                 the app is rebuilt or updated, because Keychain entries are \
                 tied to the signature that created them. Enter the password \
                 again to re-save it."
                    .to_string(),
            )),
            Err(e) => Err(AppError::Keychain(e.to_string())),
        }
    }

    pub fn set(account: &str, password: &str) -> Result<(), AppError> {
        set_generic_password(SERVICE, account, password.as_bytes())
            .map_err(|e| AppError::Keychain(e.to_string()))
    }

    pub fn delete(account: &str) -> Result<(), AppError> {
        match delete_generic_password(SERVICE, account) {
            Ok(()) => Ok(()),
            // Already absent, which is the end state the caller wanted.
            Err(e) if e.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(()),
            Err(e) => Err(AppError::Keychain(e.to_string())),
        }
    }
}

/// Windows Credential Manager and Linux kernel keyutils, through
/// `keyring`. Neither has been exercised on a real machine — see the
/// Windows and Linux entry in docs/BACKLOG.md.
#[cfg(not(target_os = "macos"))]
mod backend {
    use super::{AppError, SERVICE};
    use keyring::Entry;

    fn entry(account: &str) -> Result<Entry, AppError> {
        Entry::new(SERVICE, account).map_err(|e| AppError::Keychain(e.to_string()))
    }

    pub fn get(account: &str) -> Result<Option<String>, AppError> {
        match entry(account)?.get_password() {
            Ok(s) => Ok(Some(s)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(AppError::Keychain(e.to_string())),
        }
    }

    pub fn set(account: &str, password: &str) -> Result<(), AppError> {
        entry(account)?
            .set_password(password)
            .map_err(|e| AppError::Keychain(e.to_string()))
    }

    pub fn delete(account: &str) -> Result<(), AppError> {
        match entry(account)?.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(AppError::Keychain(e.to_string())),
        }
    }
}

/// Store a password. `account` is the connection id, so each connection
/// has exactly one entry.
///
/// Writing overwrites in place: one store operation, one prompt. It used
/// to delete first, which prompted twice.
///
/// The delete survives as a fallback, because the delete-first order
/// existed for a reason: macOS grants Keychain access per code
/// signature, and `tauri dev` re-signs the binary on every rebuild, so
/// an entry written by the previous build can be unreadable AND
/// unwritable by this one. Without a way to remove it, a user whose
/// credential became inaccessible could never replace it — the password
/// prompt would reappear forever, failing identically every time.
/// Deleting and retrying once makes the second attempt a fresh entry
/// this binary owns, and costs the extra prompt only when the write
/// actually failed.
pub fn save_password(account: &str, password: &str) -> Result<(), AppError> {
    match backend::set(account, password) {
        Ok(()) => Ok(()),
        Err(_) => {
            // The delete's own result is ignored on purpose: if it
            // failed there was nothing to remove, and the retry below is
            // what reports whether we ended up with a usable entry.
            let _ = backend::delete(account);
            backend::set(account, password)
        }
    }
}

/// Read a password. A missing entry is `Ok(None)`, not an error — the
/// caller cannot distinguish "no password saved" from "lookup broke"
/// otherwise.
///
/// Everything else is surfaced. This used to fail open on every error,
/// which swallowed the routine development case: a rebuilt binary loses
/// access to entries it saved moments earlier, and collapsing that to
/// `Ok(None)` sent `connect_saved` down the no-password path, producing
/// a driver error that named neither the Keychain nor the fix.
pub fn load_password(account: &str) -> Result<Option<String>, AppError> {
    backend::get(account)
}

/// Remove a password. Deleting something already absent is success — the
/// end state the caller wants already holds. Any other failure is
/// surfaced rather than swallowed: reporting success on a deletion that
/// did not happen would leave a credential in the store while the app
/// claims it is gone.
pub fn delete_password(account: &str) -> Result<(), AppError> {
    backend::delete(account)
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
    fn a_missing_entry_reads_as_none() {
        let account = format!("absent-{}", std::process::id());
        assert_eq!(load_password(&account).unwrap(), None);
    }

    #[test]
    fn deleting_an_absent_entry_is_ok() {
        let account = format!("never-existed-{}", std::process::id());
        assert!(delete_password(&account).is_ok());
    }

    /// `save_password` must overwrite an existing entry rather than
    /// erroring or leaving the old value, with no delete in between.
    /// This is the path the inline password retry depends on: a user
    /// whose entry became inaccessible has to be able to replace it.
    #[test]
    fn saving_twice_overwrites() {
        let account = format!("replace-{}", std::process::id());
        let _guard = CleansUpOnDrop(&account);

        save_password(&account, "first").expect("first save");
        save_password(&account, "second").expect("second save must replace");

        assert_eq!(load_password(&account).unwrap().as_deref(), Some("second"));
    }
}
