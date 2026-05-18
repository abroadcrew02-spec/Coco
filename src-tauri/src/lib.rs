pub mod commands;
pub mod db;
mod error;

use tauri::menu::{MenuBuilder, SubmenuBuilder};
use tauri::{Emitter, Manager};

/// Platform-appropriate modifier-key label for menu accelerator hints.
/// macOS uses "Cmd"; Windows/Linux use "Ctrl". The keybindings themselves
/// are routed through useGlobalShortcuts (ctrlKey || metaKey), so this is
/// purely a display concern.
#[cfg(target_os = "macos")]
const MOD: &str = "Cmd";
#[cfg(not(target_os = "macos"))]
const MOD: &str = "Ctrl";

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

            // req 7.2: native menu bar. Items emit a "menu-action" event with
            // their id; the frontend listens and routes to existing store
            // actions or editor commands.
            let file_menu = SubmenuBuilder::new(app, "ファイル")
                .text("new", format!("新規ワークブック\t{MOD}+N"))
                .text("open", format!("開く...\t{MOD}+O"))
                .separator()
                .text("save", format!("保存\t{MOD}+S"))
                .text("save-as", format!("名前を付けて保存...\t{MOD}+Shift+S"))
                .separator()
                .text("file-templates", "テンプレートから新規作成...")
                .text("file-page-setup", "ページ設定...")
                .text("file-csv-import-wizard", "CSV インポート ウィザード...")
                .text("file-import-sheet", "シートを別ファイルから取り込み...")
                .text("snapshot-now", "今すぐスナップショット")
                .text("file-quick-print", format!("印刷プレビュー\t{MOD}+P"))
                .separator()
                .text("export-xlsx", "xlsx エクスポート...")
                .text("export-csv", "CSV エクスポート...")
                .text("export-html", "HTML エクスポート...")
                .text("export-pdf", "PDF エクスポート...")
                .separator()
                .text("export-workspace-bundle", "ワークスペースバンドル出力 (.zip)...")
                .text("import-workspace-bundle", "ワークスペースバンドル読込 (.zip)...")
                .separator()
                .text("close", "終了")
                .build()?;
            let edit_menu = SubmenuBuilder::new(app, "編集")
                .text(
                    "edit-command-palette",
                    format!("コマンドパレット...\t{MOD}+Shift+P"),
                )
                .separator()
                .text("edit-flash-fill", format!("フラッシュフィル\t{MOD}+E"))
                .text("edit-quick-analysis", format!("クイック分析\t{MOD}+Q"))
                .text("edit-find-replace-all", format!("検索と置換 (全シート)...\t{MOD}+Shift+H"))
                .text("edit-go-to", format!("ジャンプ / 名前ボックス\t{MOD}+G"))
                .text("bookmark-add-current", format!("ブックマークを追加\t{MOD}+D"))
                .build()?;
            let view_menu = SubmenuBuilder::new(app, "表示")
                .text("view-snapshots", "スナップショット...")
                .text("view-tables-panel", "テーブル一覧")
                .text("view-sparklines-panel", "スパークライン一覧")
                .text("view-pivots-panel", "ピボット一覧")
                .text("view-slicers-panel", "スライサー一覧")
                .text("view-charts-canvas-panel", "グラフ表示")
                .text("view-errors-panel", "エラー一覧")
                .text("view-trace-panel", "依存関係...")
                .text("view-watch-window", "ウォッチウィンドウ")
                .text("view-bookmarks-panel", "ブックマーク一覧")
                .text("view-snapshot-diff", "スナップショット比較...")
                .text("view-snapshot-controls", "スナップショット設定...")
                .text("view-comments-manager", "コメント一覧...")
                .text("view-image-manager", "画像一覧...")
                .text("view-sheet-note", "シートのメモ...")
                .text("view-workbook-stats", "ブック統計...")
                .separator()
                .text("view-show-formulas", format!("数式の表示\t{MOD}+`"))
                .text("view-show-all-comments", "コメントをすべて表示")
                .separator()
                .text("settings", "設定...")
                .build()?;
            let insert_menu = SubmenuBuilder::new(app, "挿入")
                .text("insert-hyperlink", "ハイパーリンク...")
                .text("insert-comment", "コメント...")
                .text("insert-chart", "グラフ...")
                .text("insert-image", "画像...")
                .separator()
                .text("insert-table", "テーブル...")
                .text("insert-sparkline", "スパークライン...")
                .text("insert-pivot", "ピボットテーブル...")
                .text("insert-slicer", "スライサー...")
                .text("insert-recommended-charts", "おすすめグラフ...")
                .separator()
                .text("insert-function", "関数の挿入...\tShift+F3")
                .text("insert-symbol", "記号 / シンボル...")
                .build()?;
            let format_menu = SubmenuBuilder::new(app, "書式")
                .text("format-number", "表示形式...")
                .text("format-currency", "通貨")
                .text("format-percent", "パーセント")
                .separator()
                .text("format-cell-styles", "セルスタイル...")
                .text("format-manage-codes", "表示形式: 一覧管理...")
                .text("format-conditional", "条件付き書式...")
                .text("format-cf-manage-rules", "条件付き書式: ルールの管理...")
                .text("format-painter", "書式のコピー")
                .text("format-tab-color", "シート見出しの色...")
                .separator()
                .text("sheet-hide-active", "シートを非表示")
                .text("sheet-unhide", "シートの再表示...")
                .text("sheet-move-copy", "シートの移動 / コピー...")
                .build()?;
            let data_menu = SubmenuBuilder::new(app, "データ")
                .text("data-sort", "並べ替え...")
                .text("data-validation", "データの入力規則...")
                .text("data-named-ranges", "名前付き範囲...")
                .text("data-autosum", "オートSUM")
                .separator()
                .text("data-outline-groups", "グループ化 / アウトライン...")
                .text("data-subtotal", "小計...")
                .separator()
                .text("data-text-to-columns", "区切り位置...")
                .text("data-remove-duplicates", "重複の削除...")
                .text("data-advanced-filter", "フィルターの詳細設定...")
                .separator()
                .text("data-forecast-sheet", "予測シート...")
                .text("data-form", "データフォーム...")
                .separator()
                .text("data-smart-date", "日付に変換...")
                .text("data-bulk-clean", "データクリーニング...")
                .text("data-convert-to-range", "テーブル → 通常の範囲に変換...")
                .text("data-range-compare", "範囲の比較...")
                .separator()
                .text("data-sort-by-color", "色で並べ替え...")
                .text("data-filter-by-color", "色でフィルター...")
                .build()?;
            let tools_menu = SubmenuBuilder::new(app, "ツール")
                .text("tools-sheet-protection", "シート保護...")
                .separator()
                .text("tools-goal-seek", "ゴールシーク...")
                .text("tools-error-checking", "エラーチェック...")
                .text("tools-spell-check", "スペルチェック (英語)...")
                .text("tools-document-inspector", "ドキュメント検査...")
                .separator()
                .text("tools-scenarios", "シナリオの管理...")
                .separator()
                .text("calc-options", "計算オプション...")
                .text("calc-recalc-all", "再計算\tF9")
                .text("calc-recalc-sheet", "シート再計算\tShift+F9")
                .separator()
                .text("settings-custom-lists", "ユーザー設定リスト...")
                .text("watch-add-active", "現在のセルを監視に追加")
                .build()?;
            let help_menu = SubmenuBuilder::new(app, "ヘルプ")
                .text("help", "ヘルプ\tF1")
                .build()?;
            let menu = MenuBuilder::new(app)
                .item(&file_menu)
                .item(&edit_menu)
                .item(&view_menu)
                .item(&insert_menu)
                .item(&format_menu)
                .item(&data_menu)
                .item(&tools_menu)
                .item(&help_menu)
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
            commands::file_io::existing_csv_export_paths,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
