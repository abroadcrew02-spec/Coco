// Maps Rust-side error codes to user-facing messages.
// Codes are emitted by xlsx_io / xls_io / csv_io / workbook / recovery commands.
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

    // xls (Excel 97-2003) import — commands/xls_io.rs. Exact-match codes carry no tail.
    XLS_PASSWORD_PROTECTED:
      "パスワードで保護された .xls は開けません。Excel でパスワードを解除して保存し直してください。",
    XLS_NO_WORKSHEETS: "読み込めるワークシートがありません。",
    XLS_TOO_MANY_CELLS:
      "この .xls は大きすぎて開けません。データの入っている範囲が上限を超えています。Excel で不要な行や列を削除してから開いてください。",

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

    XLS_PASSWORD_PROTECTED:
      "A password-protected .xls file cannot be opened. Remove the password in Excel and save it again.",
    XLS_NO_WORKSHEETS: "There are no worksheets that can be read.",
    XLS_TOO_MANY_CELLS:
      "This .xls file is too large to open. The range that holds data exceeds the limit. Delete unused rows or columns in Excel, then open it again.",

    CSV_INVALID_EXTENSION: "The file extension is not .csv / .tsv.",
    CSV_EMPTY_WORKBOOK: "No sheets were found to export.",
    CSV_TOO_LARGE: "The CSV exceeds the cell-count limit (5 million).",

    REVEAL_EMPTY_PATH: "No file path was provided.",
  },
};

type PrefixFormatter = (rest: string) => string;

// XLS_NOT_EXCEL97 hints come from the Rust sniffer: html | xml | text | empty | unknown.
// Unknown hints fall back to the plain sentence so a new hint never leaks raw text.
function xlsNotExcel97Ja(hint: string): string {
  const head = "このファイルは Excel 97-2003 形式ではありません。";
  switch (hint) {
    case "html":
      return `${head}中身は Web ページ（HTML）です。Excel で開いて .xlsx として保存し直してください。`;
    case "xml":
      return `${head}中身は XML スプレッドシート 2003 です。Excel で開いて .xlsx として保存し直してください。`;
    case "text":
      return `${head}中身はテキスト（CSV / TSV など）のようです。拡張子を .csv か .tsv に変えて開いてください。`;
    default:
      return head;
  }
}

function xlsNotExcel97En(hint: string): string {
  const head = "This file is not in Excel 97-2003 format.";
  switch (hint) {
    case "html":
      return `${head} Its content is a web page (HTML). Open it in Excel and save it again as .xlsx.`;
    case "xml":
      return `${head} Its content is an XML Spreadsheet 2003. Open it in Excel and save it again as .xlsx.`;
    case "text":
      return `${head} It looks like text (CSV / TSV). Change the extension to .csv or .tsv and open it again.`;
    default:
      return head;
  }
}

/** "XLS_TOO_LARGE: <MB>" — tolerate a trailing "MB" unit in the detail. */
const xlsSizeMb = (rest: string): string => rest.trim().replace(/\s*MB$/i, "");

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
    // "File not found: <path>" — open_nicel_core when the .coco path is missing
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
    // xls_io.rs — "<CODE>: <detail>" (colon + one space). Every XLS_NOT_EXCEL97
    // sentence contains "Excel 97-2003 形式ではありません".
    ["XLS_NOT_EXCEL97:", (rest) => xlsNotExcel97Ja(rest.trim())],
    ["XLS_TOO_LARGE:", (rest) => `.xls のファイルサイズが上限（50 MB）を超えています（${xlsSizeMb(rest)} MB）。`],
    ["XLS_CORRUPT:", (rest) => `.xls を読み取れませんでした。ファイルが壊れているか、対応していない形式です（${rest.trim()}）。`],
    ["XLS_READ_FAILED:", (rest) => `ファイルを読み込めませんでした（${rest.trim()}）。`],
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
    ["XLS_NOT_EXCEL97:", (rest) => xlsNotExcel97En(rest.trim())],
    ["XLS_TOO_LARGE:", (rest) => `The .xls file exceeds the size limit (50 MB) (${xlsSizeMb(rest)} MB).`],
    ["XLS_CORRUPT:", (rest) => `Could not read the .xls file. It may be corrupted or in an unsupported format (${rest.trim()}).`],
    ["XLS_READ_FAILED:", (rest) => `Could not read the file (${rest.trim()}).`],
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
