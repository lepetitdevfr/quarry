use crate::error::AppError;
use keyring::Entry;

/// Keychain service name — groups all of Quarry's entries together, so
/// a user can find and revoke them in Keychain Access.
const SERVICE: &str = "com.quarry.app";

/// One handle to the platform credential store for `account`. Building
/// it is cheap and does no I/O, so each call makes its own rather than
/// caching one and having to reason about thread-safety.
fn entry(account: &str) -> Result<Entry, AppError> {
    Entry::new(SERVICE, account).map_err(|e| AppError::Keychain(e.to_string()))
}

/// Store a password. `account` is the connection id, so each connection
/// has exactly one entry.
///
/// `set_password` overwrites in place, which is one credential-store
/// operation and therefore one macOS Keychain prompt. This used to
/// delete before writing, which prompted twice.
///
/// The delete survives as a fallback, because the delete-first order
/// existed for a reason: macOS grants Keychain access per code
/// signature, and `tauri dev` re-signs the binary on every rebuild, so
/// an entry written by the previous build is unreadable AND unwritable
/// by this one — both `get` and `set` fail with `errSecAuthFailed`.
/// Without a way to remove that entry, a user whose credential became
/// inaccessible could never replace it: the password prompt would
/// reappear forever, failing identically every time. Deleting and
/// retrying once turns the second attempt into a fresh entry this
/// binary owns. It only costs the extra prompt when the write actually
/// failed, rather than on every save.
pub fn save_password(account: &str, password: &str) -> Result<(), AppError> {
    let entry = entry(account)?;

    match entry.set_password(password) {
        Ok(()) => Ok(()),
        Err(_) => {
            // The delete's own result is ignored on purpose: if it
            // failed there was nothing to remove, and the retry below
            // is what reports whether we ended up with a usable entry.
            let _ = entry.delete_credential();
            entry
                .set_password(password)
                .map_err(|e| AppError::Keychain(e.to_string()))
        }
    }
}

/// `errSecAuthFailed`: the entry exists, but this process is not
/// authorised to read it — typically because the binary's code
/// signature changed since the entry was written. `keyring` has no
/// portable variant for this, so we read the raw OSStatus back out of
/// the error it boxes; hence the literal, with the name here so it
/// stays greppable against Security/SecBase.h.
#[cfg(target_os = "macos")]
const ERR_SEC_AUTH_FAILED: i32 = -25293;

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
/// `Error::NoEntry` — genuinely no entry for this account — maps to
/// `Ok(None)`; every other failure is a real, actionable condition and
/// is surfaced as `Err`.
pub fn load_password(account: &str) -> Result<Option<String>, AppError> {
    match entry(account)?.get_password() {
        Ok(s) => Ok(Some(s)),
        // Nothing saved under this account, which is a normal state,
        // not a failure. This is the portable spelling of what macOS
        // reports as errSecItemNotFound.
        Err(keyring::Error::NoEntry) => Ok(None),
        // errSecAuthFailed: the entry exists but this binary is not
        // allowed to read it. macOS reports this as "The user name or
        // passphrase you entered is not correct", which sounds like a
        // database credential problem and sends people looking in
        // entirely the wrong place. Say what it actually is, and what
        // fixes it — re-entering the password replaces the entry with
        // one this binary owns (see `save_password`).
        //
        // macOS-only because this is a code-signature ACL condition
        // with no equivalent elsewhere; other platforms fall through to
        // the generic arm below.
        #[cfg(target_os = "macos")]
        Err(keyring::Error::PlatformFailure(ref e))
            if e.downcast_ref::<security_framework::base::Error>()
                .is_some_and(|e| e.code() == ERR_SEC_AUTH_FAILED) =>
        {
            Err(AppError::Keychain(
                "macOS denied access to the saved password. This happens after \
                 the app is rebuilt or updated, because Keychain entries are \
                 tied to the signature that created them. Enter the password \
                 again to re-save it."
                    .to_string(),
            ))
        }
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
    match entry(account)?.delete_credential() {
        Ok(()) => Ok(()),
        // Nothing to delete, so the caller's goal (no password stored
        // under this account) is already met.
        Err(keyring::Error::NoEntry) => Ok(()),
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
