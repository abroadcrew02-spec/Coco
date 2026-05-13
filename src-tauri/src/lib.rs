pub mod commands;
pub mod db;
mod error;

use tauri::menu::{MenuBuilder, SubmenuBuilder};
use tauri::{Emitter, Manager};

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // req 7.2: native menu bar. Items emit a "menu-action" event with
            // their id; the frontend listens and routes to existing store
            // actions. Edit menu items (undo/copy/find/etc.) are intentionally
            // omitted — Univer's built-in chrome already handles them.
            let file_menu = SubmenuBuilder::new(app, "ファイル")
                .text("new", "新規ワークブック\tCtrl+N")
                .text("open", "開く...\tCtrl+O")
                .separator()
                .text("save", "保存\tCtrl+S")
                .text("save-as", "名前を付けて保存...\tCtrl+Shift+S")
                .separator()
                .text("export-xlsx", "xlsx エクスポート...")
                .text("export-csv", "CSV エクスポート...")
                .separator()
                .text("close", "終了")
                .build()?;
            let view_menu = SubmenuBuilder::new(app, "表示")
                .text("settings", "設定...")
                .separator()
                .text("help", "ヘルプ\tF1")
                .build()?;
            let menu = MenuBuilder::new(app)
                .item(&file_menu)
                .item(&view_menu)
                .build()?;
            app.set_menu(menu)?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            // Emit to the frontend; React listens and dispatches.
            let id = event.id().as_ref().to_string();
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.emit("menu-action", id);
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::workbook::workbook_new,
            commands::workbook::workbook_open_coco,
            commands::workbook::workbook_save,
            commands::workbook::workbook_save_as,
            commands::workbook::workbook_autosave_coco,
            commands::workbook::workbook_list_recent,
            commands::workbook::workbook_remove_recent,
            commands::workbook::workbook_clear_recent,
            commands::workbook::workbook_list_recovery,
            commands::workbook::workbook_restore_backup,
            commands::recovery::workbook_autosave_temp,
            commands::recovery::workbook_clear_recovery,
            commands::security::security_scan_xlsx,
            commands::xlsx_io::workbook_import_xlsx,
            commands::xlsx_io::workbook_export_xlsx,
            commands::csv_io::workbook_export_csv,
            commands::csv_io::workbook_import_csv,
            commands::csv_io::list_sheet_names,
            commands::settings::get_setting,
            commands::settings::set_setting,
            commands::settings::list_settings,
            commands::settings::delete_setting,
            commands::shell::reveal_in_file_manager,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
