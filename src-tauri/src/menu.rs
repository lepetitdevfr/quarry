//! The application menu.
//!
//! Exists for one reason: to take `⌘W` away from "Close Window" and give
//! it to "Close Tab". On macOS a menu key equivalent is handled by
//! AppKit before the keystroke ever reaches the webview, so a `keydown`
//! listener in the frontend cannot claim `⌘W` while the default menu
//! still binds it — the window just closes.
//!
//! Tauri's `Menu::default` binds `close_window` twice, in both the File
//! and Window submenus, so there is no single item to remove. This
//! rebuilds the default menu faithfully and swaps those two items.
//!
//! **Everything else here is a copy of `Menu::default`** (see
//! `tauri::menu::Menu::default`). That matters most for the Edit
//! submenu: those predefined items are what make `⌘C`, `⌘V`, `⌘Z` and
//! `⌘A` work inside the SQL editor on macOS, and dropping them would
//! break text editing across the whole app. If a future Tauri version
//! adds to the default menu, this will not pick it up.
//!
//! This module holds the only `cfg(target_os)` in the crate, and the
//! whole custom menu sits behind it, because both reasons the menu
//! exists are macOS reasons. AppKit is what swallows `⌘W` before the
//! webview sees it, and an AppKit menu is what routes clipboard and
//! undo commands into a WKWebView at all; on Windows and Linux the
//! webview handles `Ctrl+C`/`Ctrl+V`/`Ctrl+Z` itself and nothing
//! intercepts `Ctrl+W`. There is no problem to solve off macOS, so
//! those builds take Tauri's default menu unchanged. Keep new
//! `cfg(target_os)` gates out of the rest of the crate.

use tauri::menu::Menu;
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// Menu item id for Close Tab. The frontend never sees this; it sees
/// the event below.
pub const CLOSE_TAB_ID: &str = "close_tab";

/// Menu item id for Close Window.
pub const CLOSE_WINDOW_ID: &str = "close_window";

/// Emitted when Close Tab is chosen. The frontend decides what closing
/// means — which tab is active is its state, not ours.
pub const CLOSE_TAB_EVENT: &str = "menu://close-tab";

/// Build the menu. See the module comment for why this is macOS-only.
#[cfg(target_os = "macos")]
pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    use tauri::menu::{AboutMetadata, MenuItem, PredefinedMenuItem, Submenu};

    let pkg_info = app.package_info();
    let config = app.config();
    let about_metadata = AboutMetadata {
        name: Some(pkg_info.name.clone()),
        version: Some(pkg_info.version.to_string()),
        copyright: config.bundle.copyright.clone(),
        authors: config.bundle.publisher.clone().map(|p| vec![p]),
        ..Default::default()
    };

    // The two items that replace `PredefinedMenuItem::close_window`.
    // Custom rather than predefined because a predefined item's
    // accelerator cannot be changed — which is the entire problem.
    let close_tab = MenuItem::with_id(app, CLOSE_TAB_ID, "Close Tab", true, Some("CmdOrCtrl+W"))?;
    let close_window = MenuItem::with_id(
        app,
        CLOSE_WINDOW_ID,
        "Close Window",
        true,
        // Shifted, so closing the window stays reachable and stays
        // deliberate. Nothing else in the app uses this chord.
        Some("Shift+CmdOrCtrl+W"),
    )?;

    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &close_window,
        ],
    )?;

    Menu::with_items(
        app,
        &[
            &Submenu::with_items(
                app,
                pkg_info.name.clone(),
                true,
                &[
                    &PredefinedMenuItem::about(app, None, Some(about_metadata))?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::services(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::hide(app, None)?,
                    &PredefinedMenuItem::hide_others(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::quit(app, None)?,
                ],
            )?,
            &Submenu::with_items(app, "File", true, &[&close_tab])?,
            // Do not touch this submenu. These predefined items are how
            // copy, paste, undo and select-all reach the webview on
            // macOS; without them the SQL editor loses them entirely.
            &Submenu::with_items(
                app,
                "Edit",
                true,
                &[
                    &PredefinedMenuItem::undo(app, None)?,
                    &PredefinedMenuItem::redo(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::cut(app, None)?,
                    &PredefinedMenuItem::copy(app, None)?,
                    &PredefinedMenuItem::paste(app, None)?,
                    &PredefinedMenuItem::select_all(app, None)?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "View",
                true,
                &[&PredefinedMenuItem::fullscreen(app, None)?],
            )?,
            &window_menu,
            &Submenu::with_items(app, "Help", true, &[])?,
        ],
    )
}

/// Everywhere else, the default menu already does the right thing.
#[cfg(not(target_os = "macos"))]
pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    Menu::default(app)
}

/// Handle a click on one of the two custom items.
///
/// Close Tab is forwarded to the frontend, which owns tab state. Close
/// Window is carried out here, since it is ours to do.
pub fn on_event<R: Runtime>(app: &AppHandle<R>, id: &str) {
    match id {
        CLOSE_TAB_ID => {
            // A failure here means no frontend is listening, which is
            // not worth crashing the app over.
            let _ = app.emit(CLOSE_TAB_EVENT, ());
        }
        CLOSE_WINDOW_ID => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.close();
            }
        }
        _ => {}
    }
}
