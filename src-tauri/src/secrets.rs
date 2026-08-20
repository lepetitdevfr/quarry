use std::collections::BTreeMap;
use std::sync::Mutex;

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

/// The one Keychain item every connection's password lives in.
///
/// macOS authorises Keychain access per *item*, so one entry per
/// connection meant one prompt per connection, repeated after every
/// rebuild because entries are tied to the signing identity. A single
/// item keyed by connection id is one ACL and therefore one prompt.
///
/// The cost is deliberate: Keychain Access shows one opaque entry
/// instead of a legible one per connection, and any read decrypts every
/// credential. See docs/BACKLOG.md.
const BLOB_ACCOUNT: &str = "connections";

/// Serialises the read-modify-write around the shared item. Two threads
/// saving different connections at once would otherwise each read the
/// same map and write back their own, losing one of the passwords.
static BLOB_LOCK: Mutex<()> = Mutex::new(());

/// A store of named items — the two or three operations the blob logic
/// needs from a credential store, and nothing else.
///
/// It exists so the merge, migration and delete rules can be tested
/// without a real Keychain. That is not tidiness: macOS binds an
/// "Always Allow" grant to the requesting binary's code signature, and
/// `cargo test` re-links a differently-signed test binary on every
/// build, so tests against the real store prompt on every single run and
/// no amount of allowing settles it.
trait Items {
    fn get(&self, account: &str) -> Result<Option<String>, AppError>;
    fn set(&self, account: &str, secret: &str) -> Result<(), AppError>;
    fn delete(&self, account: &str) -> Result<(), AppError>;
}

/// The real credential store, which is what everything outside this
/// module's tests runs against.
struct Platform;

impl Items for Platform {
    fn get(&self, account: &str) -> Result<Option<String>, AppError> {
        backend::get(account)
    }

    fn set(&self, account: &str, secret: &str) -> Result<(), AppError> {
        backend::set(account, secret)
    }

    fn delete(&self, account: &str) -> Result<(), AppError> {
        backend::delete(account)
    }
}

/// Read the map. A missing item is an empty map, not an error — nothing
/// has been saved yet.
///
/// Unparseable contents are an error rather than a silent reset:
/// overwriting a blob we cannot read would destroy every stored
/// credential to recover from a bug.
fn read_blob(items: &impl Items) -> Result<BTreeMap<String, String>, AppError> {
    match items.get(BLOB_ACCOUNT)? {
        None => Ok(BTreeMap::new()),
        Some(json) => serde_json::from_str(&json)
            .map_err(|e| AppError::Keychain(format!("stored credentials are unreadable: {e}"))),
    }
}

/// Write the map back.
///
/// Writing overwrites in place: one store operation, one prompt. The
/// delete-and-retry exists because macOS grants Keychain access per code
/// signature, and `tauri dev` re-signs the binary on every rebuild, so an
/// item written by the previous build can be unreadable AND unwritable by
/// this one. Without a way to remove it, a user whose credentials became
/// inaccessible could never replace them. Deleting and retrying once
/// makes the second attempt a fresh item this binary owns, and costs the
/// extra prompt only when the write actually failed.
fn write_blob(items: &impl Items, map: &BTreeMap<String, String>) -> Result<(), AppError> {
    let json = serde_json::to_string(map).map_err(|e| AppError::Keychain(e.to_string()))?;

    match items.set(BLOB_ACCOUNT, &json) {
        Ok(()) => Ok(()),
        Err(_) => {
            // The delete's own result is ignored on purpose: if it
            // failed there was nothing to remove, and the retry below is
            // what reports whether we ended up with a usable item.
            let _ = items.delete(BLOB_ACCOUNT);
            items.set(BLOB_ACCOUNT, &json)
        }
    }
}

fn save_in(items: &impl Items, account: &str, password: &str) -> Result<(), AppError> {
    let _guard = BLOB_LOCK.lock().unwrap_or_else(|e| e.into_inner());

    let mut map = read_blob(items)?;
    map.insert(account.to_string(), password.to_string());
    write_blob(items, &map)?;

    // A pre-blob entry for this id would otherwise sit there forever,
    // unread and undeletable from the UI. Failure is ignored: the
    // password the caller asked us to store is already stored, and a
    // stale item can no longer shadow it because the blob is read first.
    let _ = items.delete(account);

    Ok(())
}

fn load_from(items: &impl Items, account: &str) -> Result<Option<String>, AppError> {
    let _guard = BLOB_LOCK.lock().unwrap_or_else(|e| e.into_inner());

    let mut map = read_blob(items)?;
    if let Some(password) = map.get(account) {
        return Ok(Some(password.clone()));
    }

    let Some(password) = items.get(account)? else {
        return Ok(None);
    };

    // Migrate, then return the password whether or not the migration
    // stuck: the caller asked for a credential we have in hand, and a
    // failed move only means the next read migrates again.
    map.insert(account.to_string(), password.clone());
    if write_blob(items, &map).is_ok() {
        let _ = items.delete(account);
    }

    Ok(Some(password))
}

fn delete_from(items: &impl Items, account: &str) -> Result<(), AppError> {
    let _guard = BLOB_LOCK.lock().unwrap_or_else(|e| e.into_inner());

    let mut map = read_blob(items)?;
    if map.remove(account).is_some() {
        write_blob(items, &map)?;
    }

    // A pre-blob entry for this id must go too, or "delete" would leave
    // a live credential behind for the next build to migrate back in.
    items.delete(account)
}

/// Store a password under a connection id.
pub fn save_password(account: &str, password: &str) -> Result<(), AppError> {
    save_in(&Platform, account, password)
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
///
/// A password saved by a pre-blob build is migrated on first read, which
/// costs one prompt for that old item once and none afterwards.
pub fn load_password(account: &str) -> Result<Option<String>, AppError> {
    load_from(&Platform, account)
}

/// Remove a password. Deleting something already absent is success — the
/// end state the caller wants already holds. Any other failure is
/// surfaced rather than swallowed: reporting success on a deletion that
/// did not happen would leave a credential in the store while the app
/// claims it is gone.
pub fn delete_password(account: &str) -> Result<(), AppError> {
    delete_from(&Platform, account)
}

/// Where a connection's password is kept, as far as the rest of the app
/// is concerned.
///
/// One trait with two implementations, because a test must never reach
/// the real Keychain: macOS binds an "Always Allow" grant to the
/// requesting binary's code signature and `cargo test` re-links a
/// differently-signed binary on every build, so a suite that touches the
/// real store prompts the developer on every single run and no amount of
/// allowing ever settles it. The module's own tests already worked this
/// way; this extends the same seam to everything that reaches credentials
/// through `Store`.
pub trait Credentials: Send + Sync {
    fn save(&self, id: &str, password: &str) -> Result<(), AppError>;
    fn load(&self, id: &str) -> Result<Option<String>, AppError>;
    fn delete(&self, id: &str) -> Result<(), AppError>;
}

/// The real one: the platform credential store, with the blob rules
/// above. This is what the app runs.
pub struct Keychain;

impl Credentials for Keychain {
    fn save(&self, id: &str, password: &str) -> Result<(), AppError> {
        save_password(id, password)
    }

    fn load(&self, id: &str) -> Result<Option<String>, AppError> {
        load_password(id)
    }

    fn delete(&self, id: &str) -> Result<(), AppError> {
        delete_password(id)
    }
}

/// A credential store that lives and dies with the process.
///
/// For tests. It keeps the same contract — a missing entry loads as
/// `None`, deleting an absent one succeeds — so a test exercises the
/// rules the real store follows without asking macOS for permission.
#[derive(Default)]
pub struct EphemeralCredentials {
    items: Mutex<BTreeMap<String, String>>,
}

impl Credentials for EphemeralCredentials {
    fn save(&self, id: &str, password: &str) -> Result<(), AppError> {
        self.lock().insert(id.to_string(), password.to_string());
        Ok(())
    }

    fn load(&self, id: &str) -> Result<Option<String>, AppError> {
        Ok(self.lock().get(id).cloned())
    }

    fn delete(&self, id: &str) -> Result<(), AppError> {
        self.lock().remove(id);
        Ok(())
    }
}

impl EphemeralCredentials {
    fn lock(&self) -> std::sync::MutexGuard<'_, BTreeMap<String, String>> {
        // Same reasoning as `Store::lock`: the data behind this mutex is
        // a map, structurally valid whether or not a holder panicked.
        self.items.lock().unwrap_or_else(|e| e.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    /// An in-memory stand-in for the platform store.
    ///
    /// Every test below one exercises the blob rules against this rather
    /// than the real Keychain, on purpose: macOS ties an "Always Allow"
    /// grant to the requesting binary's signature, `cargo test` re-links
    /// a new one on each build, so real-store tests prompt the developer
    /// on every run forever. The one test that must touch the real store
    /// is `#[ignore]`d.
    #[derive(Default)]
    struct FakeItems {
        items: StdMutex<BTreeMap<String, String>>,
        /// When set, `set` fails once for this account, exercising the
        /// delete-and-retry path in `write_blob`.
        fail_next_set: StdMutex<Option<String>>,
    }

    impl FakeItems {
        fn contains(&self, account: &str) -> bool {
            self.items.lock().unwrap().contains_key(account)
        }

        fn seed(&self, account: &str, secret: &str) {
            self.items
                .lock()
                .unwrap()
                .insert(account.to_string(), secret.to_string());
        }
    }

    impl Items for FakeItems {
        fn get(&self, account: &str) -> Result<Option<String>, AppError> {
            Ok(self.items.lock().unwrap().get(account).cloned())
        }

        fn set(&self, account: &str, secret: &str) -> Result<(), AppError> {
            let mut fail = self.fail_next_set.lock().unwrap();
            if fail.as_deref() == Some(account) {
                *fail = None;
                return Err(AppError::Keychain("denied".to_string()));
            }
            self.items
                .lock()
                .unwrap()
                .insert(account.to_string(), secret.to_string());
            Ok(())
        }

        fn delete(&self, account: &str) -> Result<(), AppError> {
            self.items.lock().unwrap().remove(account);
            Ok(())
        }
    }

    #[test]
    fn round_trips_a_password() {
        let items = FakeItems::default();

        save_in(&items, "conn-1", "hunter2").expect("save should work");
        assert_eq!(
            load_from(&items, "conn-1").unwrap().as_deref(),
            Some("hunter2")
        );

        delete_from(&items, "conn-1").expect("delete should work");
        assert_eq!(load_from(&items, "conn-1").unwrap(), None);
    }

    #[test]
    fn a_missing_entry_reads_as_none() {
        let items = FakeItems::default();
        assert_eq!(load_from(&items, "never-saved").unwrap(), None);
    }

    #[test]
    fn deleting_an_absent_entry_is_ok() {
        let items = FakeItems::default();
        assert!(delete_from(&items, "never-saved").is_ok());
    }

    /// Saving must overwrite rather than error or keep the old value.
    /// This is the path the inline password retry depends on: a user
    /// whose credential became inaccessible has to be able to replace it.
    #[test]
    fn saving_twice_overwrites() {
        let items = FakeItems::default();

        save_in(&items, "conn-1", "first").expect("first save");
        save_in(&items, "conn-1", "second").expect("second save must replace");

        assert_eq!(
            load_from(&items, "conn-1").unwrap().as_deref(),
            Some("second")
        );
    }

    /// Every connection shares one item, so a save for one must not drop
    /// another — the whole point of the blob is that the map survives a
    /// read-modify-write.
    #[test]
    fn two_accounts_coexist_in_one_item() {
        let items = FakeItems::default();

        save_in(&items, "conn-a", "alpha").expect("save a");
        save_in(&items, "conn-b", "bravo").expect("save b");

        assert_eq!(
            items.items.lock().unwrap().keys().collect::<Vec<_>>(),
            vec![BLOB_ACCOUNT],
            "both passwords belong to the single blob item"
        );
        assert_eq!(
            load_from(&items, "conn-a").unwrap().as_deref(),
            Some("alpha")
        );
        assert_eq!(
            load_from(&items, "conn-b").unwrap().as_deref(),
            Some("bravo")
        );

        delete_from(&items, "conn-a").expect("delete a");
        assert_eq!(load_from(&items, "conn-a").unwrap(), None);
        assert_eq!(
            load_from(&items, "conn-b").unwrap().as_deref(),
            Some("bravo"),
            "deleting one connection must not touch another"
        );
    }

    /// A password written by a pre-blob build lives in its own item.
    /// Reading it must return it, move it into the blob, and leave the
    /// old item gone, so the extra prompt happens once and never again.
    #[test]
    fn a_pre_blob_entry_is_migrated_on_read() {
        let items = FakeItems::default();
        items.seed("conn-old", "from-the-old-build");

        assert_eq!(
            load_from(&items, "conn-old").unwrap().as_deref(),
            Some("from-the-old-build")
        );
        assert!(
            !items.contains("conn-old"),
            "the old item should be gone once migrated"
        );
        assert_eq!(
            load_from(&items, "conn-old").unwrap().as_deref(),
            Some("from-the-old-build"),
            "the migrated password must still read back from the blob"
        );
    }

    /// Saving over a pre-blob entry must clear it, or the old value
    /// would sit in the store unreachable from the UI forever.
    #[test]
    fn saving_clears_a_pre_blob_entry() {
        let items = FakeItems::default();
        items.seed("conn-old", "stale");

        save_in(&items, "conn-old", "fresh").expect("save");

        assert!(!items.contains("conn-old"));
        assert_eq!(
            load_from(&items, "conn-old").unwrap().as_deref(),
            Some("fresh")
        );
    }

    /// Deleting has to clear a pre-blob entry too, or the next read
    /// would migrate back a credential the user asked us to forget.
    #[test]
    fn deleting_clears_a_pre_blob_entry() {
        let items = FakeItems::default();
        items.seed("conn-old", "stale");

        delete_from(&items, "conn-old").expect("delete should work");

        assert_eq!(load_from(&items, "conn-old").unwrap(), None);
    }

    /// A store that refuses the first write must not lose the password:
    /// `write_blob` deletes the offending item and writes again, which is
    /// what lets a rebuilt binary replace an item it can no longer touch.
    #[test]
    fn a_refused_write_is_retried_after_deleting_the_item() {
        let items = FakeItems::default();
        *items.fail_next_set.lock().unwrap() = Some(BLOB_ACCOUNT.to_string());

        save_in(&items, "conn-1", "hunter2").expect("the retry should succeed");

        assert_eq!(
            load_from(&items, "conn-1").unwrap().as_deref(),
            Some("hunter2")
        );
    }

    /// Unreadable contents must not be silently reset — overwriting a
    /// blob we cannot parse would destroy every stored credential.
    #[test]
    fn an_unparseable_blob_is_an_error_not_an_empty_map() {
        let items = FakeItems::default();
        items.seed(BLOB_ACCOUNT, "not json");

        assert!(load_from(&items, "conn-1").is_err());
        assert!(save_in(&items, "conn-1", "hunter2").is_err());
    }

    /// The one test that touches the real credential store, which is why
    /// it is ignored by default: on macOS it prompts, and the grant does
    /// not survive the next `cargo test` because the test binary is
    /// re-signed. Run deliberately with
    /// `cargo test -- --ignored real_store`.
    #[test]
    #[ignore = "touches the real credential store and prompts on macOS"]
    fn the_real_store_round_trips_a_password() {
        let account = format!("test-{}", std::process::id());

        save_password(&account, "hunter2").expect("save should work");
        assert_eq!(load_password(&account).unwrap().as_deref(), Some("hunter2"));

        delete_password(&account).expect("delete should work");
        assert_eq!(load_password(&account).unwrap(), None);
    }
}
