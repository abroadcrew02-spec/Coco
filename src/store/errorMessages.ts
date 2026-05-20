// Maps Rust-side error codes to user-facing messages.
// Codes are emitted by xlsx_io / csv_io / workbook / recovery commands.
// Unknown codes fall through unchanged so debugging info isn't lost.
//
// #179: messages are localized. `friendlyError` resolves the active locale
// via `getLocale()`; both ja-JP and en-US tables are kept in sync.

import { getLocale, type Locale } from "../i18n/locale";

const FRIENDLY: Record<Locale, Record<string, string>> = {
  "ja-JP": {
    // workbook save
    NEEDS_PATH: "保存先が指定されていません。「名前を付けて保存」から保存先を選んでください。",

    // xlsx import/export
    XLSX_INVALID_EXTENSION: "対応していない拡張子です（.xlsx / .xlsm のみ）。",
    XLSX_EMPTY_SNAPSHOT: "出力する内容がありません。空のワークブックは保存できません。",
    XLSX_BUILD_FAILED: "xlsx の構築中にエラーが発生しました。",
    XLSX_WRITE_FAILED: "xlsx の書き込みに失敗しました。ディスク容量や権限を確認してください。",
    XLSX_SECURITY_BLOCKED: "セキュリティ上の制限を超えているため、ファイルを開けません。",

    // csv import/export
    CSV_INVALID_EXTENSION: "拡張子が .csv / .tsv ではありません。",
    CSV_EMPTY_WORKBOOK: "エクスポートできるシートが見つかりませんでした。",
    CSV_TOO_LARGE: "CSV のセル数が上限（500万）を超えています。",

    // reveal-in-file-manager (commands/shell.rs)
    REVEAL_EMPTY_PATH: "ファイルパスが指定されていません。",
  },
  "en-US": {
    NEEDS_PATH:
      "No destination is set. Choose a location via \"Save As\" first.",

    XLSX_INVALID_EXTENSION: "Unsupported file extension (.xlsx / .xlsm only).",
    XLSX_EMPTY_SNAPSHOT:
      "There is nothing to export. An empty workbook cannot be saved.",
    XLSX_BUILD_FAILED: "An error occurred while building the xlsx file.",
    XLSX_WRITE_FAILED:
      "Failed to write the xlsx file. Check available disk space and permissions.",
    XLSX_SECURITY_BLOCKED:
      "The file cannot be opened because it exceeds a security limit.",

    CSV_INVALID_EXTENSION: "The file extension is not .csv / .tsv.",
    CSV_EMPTY_WORKBOOK: "No sheets were found to export.",
    CSV_TOO_LARGE: "The CSV exceeds the cell-count limit (5 million).",

    REVEAL_EMPTY_PATH: "No file path was provided.",
  },
};

type PrefixFormatter = (rest: string) => string;

const PREFIX_FRIENDLY: Record<Locale, Array<[string, PrefixFormatter]>> = {
  "ja-JP": [
    // "CSV_TOO_LARGE: more than 5M cells" — keep the friendly translation but
    // accept the diagnostic tail Rust attaches.
    ["CSV_TOO_LARGE", (_rest) => "CSV のセル数が上限（500万）を超えています。"],
    // "Integrity check failed: <detail>"
    ["Integrity check failed:", (rest) => `保存後の整合性チェックに失敗しました（${rest.trim()}）`],
    // "rename failed: <detail>"
    ["rename failed:", (rest) => `一時ファイルの最終置換に失敗しました（${rest.trim()}）`],
    // "Sheet not found: <id>"
    ["Sheet not found:", (rest) => `指定されたシートが見つかりません（${rest.trim()}）`],
    // "Failed to open xlsx: <detail>"
    ["Failed to open xlsx:", (rest) => `xlsx を開けませんでした（${rest.trim()}）`],
    // "security scan failed: <detail>"
    ["security scan failed:", (rest) => `セキュリティ検査に失敗しました（${rest.trim()}）`],
    // "backup rotation failed: <detail>"
    ["backup rotation failed:", (rest) => `バックアップのローテーションに失敗しました（${rest.trim()}）`],
    // "File not found: <path>" — open_coco_core when the .coco path is missing
    ["File not found:", (rest) => `ファイルが見つかりません（${rest.trim()}）`],
    // "Recovery file is missing: <path>" — restore_backup_core when the temp .coco was wiped
    ["Recovery file is missing:", (rest) => `復元ファイルが見つかりません（${rest.trim()}）。候補一覧から自動的に取り除きました。`],
    // "Recovery candidate not found: <id>" — restore_backup_core when DB row missing
    ["Recovery candidate not found:", (rest) => `復元候補が見つかりません（${rest.trim()}）`],
    // "Snapshot not found: <id>" — open_snapshot_core when the snapshot row was pruned
    ["Snapshot not found:", (rest) => `スナップショットが見つかりません（${rest.trim()}）。最新版に戻されている可能性があります。`],
    // "Invalid xlsx (zip): <detail>" — security_scan when ZipArchive fails
    ["Invalid xlsx (zip):", (rest) => `xlsx として開けません。ZIP 構造が不正です（${rest.trim()}）`],
    // "REVEAL_SPAWN_FAILED: <io error>" — reveal_in_file_manager couldn't spawn explorer/open/xdg-open
    ["REVEAL_SPAWN_FAILED:", (rest) => `ファイルマネージャを起動できませんでした（${rest.trim()}）`],
  ],
  "en-US": [
    ["CSV_TOO_LARGE", (_rest) => "The CSV exceeds the cell-count limit (5 million)."],
    ["Integrity check failed:", (rest) => `The post-save integrity check failed (${rest.trim()}).`],
    ["rename failed:", (rest) => `The final replacement of the temporary file failed (${rest.trim()}).`],
    ["Sheet not found:", (rest) => `The specified sheet was not found (${rest.trim()}).`],
    ["Failed to open xlsx:", (rest) => `Could not open the xlsx file (${rest.trim()}).`],
    ["security scan failed:", (rest) => `The security scan failed (${rest.trim()}).`],
    ["backup rotation failed:", (rest) => `Backup rotation failed (${rest.trim()}).`],
    ["File not found:", (rest) => `The file was not found (${rest.trim()}).`],
    ["Recovery file is missing:", (rest) => `The recovery file is missing (${rest.trim()}). It was automatically removed from the candidate list.`],
    ["Recovery candidate not found:", (rest) => `The recovery candidate was not found (${rest.trim()}).`],
    ["Snapshot not found:", (rest) => `The snapshot was not found (${rest.trim()}). It may have been reverted to the latest version.`],
    ["Invalid xlsx (zip):", (rest) => `The xlsx file cannot be opened — its ZIP structure is invalid (${rest.trim()}).`],
    ["REVEAL_SPAWN_FAILED:", (rest) => `Could not launch the file manager (${rest.trim()}).`],
  ],
};

export function friendlyError(
  raw: string | null | undefined,
  locale: Locale = getLocale(),
): string | null {
  if (!raw) return null;
  const exact = FRIENDLY[locale][raw];
  if (exact) return exact;
  for (const [prefix, fmt] of PREFIX_FRIENDLY[locale]) {
    if (raw.startsWith(prefix)) {
      return fmt(raw.slice(prefix.length));
    }
  }
  return raw;
}
