pub mod commands;
pub mod db;
mod error;

use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .plugin(
            // #46: runtime diagnostic logging to a rotating file under the
            // app data dir (Windows: %APPDATA%/com.coco.app/logs/Coco.log,
            // macOS: ~/Library/Logs/com.coco.app/, Linux: $XDG_DATA_HOME/com.coco.app/logs/).
            // Levels are info by default; set RUST_LOG=debug for verbose
            // capture. Limited to 2 MiB per file with 5 rotated copies so
            // crash diagnostics never grow unbounded.
            tauri_plugin_log::Builder::default()
                .target(tauri_plugin_log::Target::new(
                    tauri_plugin_log::TargetKind::LogDir { file_name: Some("Coco".into()) },
                ))
                .target(tauri_plugin_log::Target::new(
                    tauri_plugin_log::TargetKind::Stdout,
                ))
                .level(log::LevelFilter::Info)
                .max_file_size(2 * 1024 * 1024)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepAll)
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // #181: registry of in-flight streaming HTTP requests, shared so the
        // `http_fetch_cancel` command can reach the streams started by
        // `http_fetch_stream`.
        .manage(std::sync::Arc::new(
            commands::http_fetch_stream::StreamRegistry::default(),
        ))
        // #182: registry of live WebSocket + SSE connections, shared so the
        // `ws_send` / `ws_close` / `sse_close` commands can reach the
        // background tasks started by `ws_connect` / `sse_connect`, and so the
        // concurrent-connection cap is enforced process-wide.
        .manage(std::sync::Arc::new(
            commands::ws_fetch::ConnRegistry::default(),
        ))
        .setup(|app| {
            // #82: best-effort startup sweep of orphan recovery .coco files
            // (file present, no recovery_candidates row). Scoped to the
            // recovery directory so user files are never touched. Errors
            // are non-fatal — log and continue with app startup.
            if let Ok(data_dir) = app.path().app_data_dir() {
                match commands::recovery::sweep_orphan_recovery_files(&data_dir) {
                    Ok(0) => {}
                    Ok(n) => log::info!("recovery sweep removed {} orphan files", n),
                    Err(e) => log::warn!("recovery sweep failed: {}", e),
                }
            }

            // #202: the Tauri native menu bar has been removed — its role is
            // now fully covered by the in-app ribbon (File / Tools tabs) and
            // the command palette. Ribbon "file" buttons emit the same
            // `menu-action` window event from the frontend, so `useMenuActions`
            // continues to drive new/open/save/export/settings unchanged.
            Ok(())
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
            commands::workbook::workbook_list_snapshots,
            commands::workbook::workbook_open_snapshot,
            commands::workbook::workbook_vacuum,
            commands::workbook::workbook_check_integrity,
            commands::workbook::workbook_diagnostic_info,
            commands::recovery::workbook_autosave_temp,
            commands::recovery::workbook_clear_recovery,
            commands::security::security_scan_xlsx,
            commands::xlsx_io::workbook_import_xlsx,
            commands::xlsx_io::workbook_export_xlsx,
            commands::csv_io::workbook_export_csv,
            commands::csv_io::workbook_import_csv,
            commands::csv_io::list_sheet_names,
            commands::data_connection::data_connection_load,
            commands::data_connection::data_connection_load_web,
            commands::data_connection::data_connection_load_sqlite,
            commands::html_export::workbook_export_html,
            commands::pdf_export::workbook_export_pdf,
            commands::workspace_bundle::workbook_export_workspace_bundle,
            commands::workspace_bundle::workbook_import_workspace_bundle,
            commands::sheet_import::workbook_extract_sheets_from_xlsx,
            commands::sheet_import::workbook_extract_sheet_as_snapshot,
            commands::settings::get_setting,
            commands::settings::set_setting,
            commands::settings::list_settings,
            commands::settings::delete_setting,
            commands::shell::reveal_in_file_manager,
            commands::shell::open_url,
            commands::file_io::read_file_bytes_base64,
            commands::file_io::read_text_file_utf8,
            commands::file_io::write_file_bytes_base64,
            commands::file_io::existing_csv_export_paths,
            commands::http_fetch::http_fetch,
            commands::http_fetch_stream::http_fetch_stream,
            commands::http_fetch_stream::http_fetch_cancel,
            commands::ws_fetch::ws_connect,
            commands::ws_fetch::ws_send,
            commands::ws_fetch::ws_close,
            commands::ws_fetch::sse_connect,
            commands::ws_fetch::sse_close,
            commands::url_fetch_credentials::url_fetch_set_credential,
            commands::url_fetch_credentials::url_fetch_delete_credential,
            commands::url_fetch_credentials::url_fetch_list_credentials,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
