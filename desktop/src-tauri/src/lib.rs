//! Annie on the desktop (docs/desktop.md): one window on the person's Annie server, an icon in
//! the tray or menu bar, and a shortcut that brings it up from anywhere. The console is the
//! server's own; the app adds only what a browser tab cannot do.

mod server;
mod settings;

use std::path::PathBuf;
use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{
    AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tauri_plugin_opener::OpenerExt;
use url::Url;

const MAIN: &str = "main";

/// The server the main window shows, once the person connected one.
#[derive(Default)]
struct Current(Mutex<Option<Url>>);

/// What the main window shows: the bundled page that asks for the server, or a page of the server.
enum Page {
    Connect,
    Server(Url),
}

#[tauri::command]
async fn connect(app: AppHandle, input: String) -> Result<(), String> {
    let server = server::parse(&input)?;
    let origin = server.origin.clone();
    tauri::async_runtime::spawn_blocking(move || server::check(&origin))
        .await
        .map_err(|e| e.to_string())??;
    settings::save(
        &settings_file(&app)?,
        &settings::Settings {
            server: Some(server.origin.to_string()),
        },
    )?;
    *app.state::<Current>().0.lock().unwrap() = Some(server.origin.clone());
    open_main(&app, Page::Server(server.start)).map_err(|e| e.to_string())
}

/// The connected server, to fill in the form when the person changes it.
#[tauri::command]
fn current(app: AppHandle) -> Option<String> {
    app.state::<Current>()
        .0
        .lock()
        .unwrap()
        .as_ref()
        .map(|u| u.to_string())
}

pub fn run() {
    tauri::Builder::default()
        // First: a second launch only brings the open window forward.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show(app)
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() == ShortcutState::Pressed && *shortcut == summon() {
                        toggle(app);
                    }
                })
                .build(),
        )
        .manage(Current::default())
        .invoke_handler(tauri::generate_handler![connect, current])
        .setup(|app| {
            let handle = app.handle().clone();
            let saved = settings::load(&settings_file(&handle)?)
                .server
                .and_then(|s| Url::parse(&s).ok());
            *handle.state::<Current>().0.lock().unwrap() = saved.clone();
            open_main(&handle, saved.map_or(Page::Connect, Page::Server))?;
            tray(&handle)?;
            // Another app may hold the shortcut: Annie still works from the tray.
            if let Err(error) = handle.global_shortcut().register(summon()) {
                eprintln!("annie: shortcut not registered: {error}");
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing hides: Annie stays in the tray, ready for the shortcut. Esci quits.
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == MAIN {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("annie: the app could not start")
        .run(|_app, event| {
            // No window open is not a reason to quit: Annie lives in the tray until Esci.
            if let RunEvent::ExitRequested {
                code: None, api, ..
            } = event
            {
                api.prevent_exit();
            }
        });
}

/// Ctrl+Shift+Space (⌘⇧Space on a Mac): Annie from any app.
fn summon() -> Shortcut {
    let command = if cfg!(target_os = "macos") {
        Modifiers::SUPER
    } else {
        Modifiers::CONTROL
    };
    Shortcut::new(Some(command | Modifiers::SHIFT), Code::Space)
}

fn settings_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(settings::file(
        &app.path().app_config_dir().map_err(|e| e.to_string())?,
    ))
}

/// Show a page in the main window, creating the window the first time. The window's
/// navigation rule reads the current server, so one window serves both kinds of page.
fn open_main(app: &AppHandle, page: Page) -> tauri::Result<()> {
    let url = match page {
        Page::Connect => bundled_page(),
        Page::Server(start) => start,
    };
    if let Some(window) = main_window(app) {
        window.navigate(url)?;
        show(app);
        return Ok(());
    }
    let guard = app.clone();
    let window = WebviewWindowBuilder::new(app, MAIN, WebviewUrl::External(url))
        .title("Annie")
        .inner_size(1180.0, 800.0)
        .min_inner_size(380.0, 520.0)
        .visible(false)
        // Pages of the server stay in the window; any other link opens in the browser.
        .on_navigation(move |target| allowed(&guard, target))
        .build()?;
    // Shown once built: no white flash before the page.
    window.show()?;
    window.set_focus()?;
    Ok(())
}

/// The bundled connect page, where Tauri serves the app's own files on each system.
fn bundled_page() -> Url {
    let base = if cfg!(windows) {
        "http://tauri.localhost/"
    } else {
        "tauri://localhost/"
    };
    Url::parse(base)
        .and_then(|u| u.join("index.html"))
        .expect("annie: a fixed address")
}

fn allowed(app: &AppHandle, target: &Url) -> bool {
    let server = app.state::<Current>().0.lock().unwrap().clone();
    match server::navigation(server.as_ref(), target) {
        server::Navigation::Stay => true,
        server::Navigation::Browser => {
            let _ = app.opener().open_url(target.as_str(), None::<&str>);
            false
        }
        server::Navigation::Refuse => false,
    }
}

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(MAIN)
}

fn show(app: &AppHandle) {
    if let Some(window) = main_window(app) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn toggle(app: &AppHandle) {
    match main_window(app) {
        Some(window)
            if window.is_visible().unwrap_or(false) && window.is_focused().unwrap_or(false) =>
        {
            let _ = window.hide();
        }
        _ => show(app),
    }
}

fn tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Apri Annie", true, None::<&str>)?;
    let chat = MenuItem::with_id(app, "chat", "Nuova chat", true, None::<&str>)?;
    let change = MenuItem::with_id(app, "server", "Cambia server…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Esci", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &open,
            &chat,
            &PredefinedMenuItem::separator(app)?,
            &change,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;
    TrayIconBuilder::with_id("annie")
        .tooltip("Annie")
        .icon(
            app.default_window_icon()
                .cloned()
                .expect("annie: the bundle has an icon"),
        )
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show(app),
            "chat" => {
                let origin = app.state::<Current>().0.lock().unwrap().clone();
                match origin.and_then(|o| o.join("/#/chat").ok()) {
                    Some(chat) => {
                        let _ = open_main(app, Page::Server(chat));
                    }
                    None => show(app),
                }
            }
            "server" => {
                let _ = open_main(app, Page::Connect);
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}
