pub mod commands;
mod db;
mod error;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::workbook::workbook_new,
            commands::workbook::workbook_open_coco,
            commands::workbook::workbook_save,
            commands::workbook::workbook_save_as,
            commands::workbook::workbook_autosave_coco,
            commands::workbook::workbook_list_recent,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
