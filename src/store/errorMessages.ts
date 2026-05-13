// Maps Rust-side error codes to user-facing Japanese messages.
// Codes are emitted by xlsx_io / csv_io / workbook / recovery commands.
// Unknown codes fall through unchanged so debugging info isn't lost.

const FRIENDLY: Record<string, string> = {
  // workbook save
  NEEDS_PATH: "保存先が指定されていません。「名前を付けて保存」から保存先を選んでください。",

  // xlsx import/export
  XLSX_INVALID_EXTENSION: "対応していない拡張子です（.xlsx / .xlsm のみ）。",
  XLSX_EMPTY_SNAPSHOT: "出力する内容がありません。空のワークブックは保存できません。",
  XLSX_BUILD_FAILED: "xlsx の構築中にエラーが発生しました。",
  XLSX_WRITE_FAILED: "xlsx の書き込みに失敗しました。ディスク容量や権限を確認してください。",
  XLSX_SECURITY_BLOCKED: "セキュリティ上の制限を超えているため、ファイルを開けません。",

  // csv import/export
  CSV_INVALID_EXTENSION: "拡張子が .csv ではありません。",
  CSV_EMPTY_WORKBOOK: "エクスポートできるシートが見つかりませんでした。",
  CSV_TOO_LARGE: "CSV のセル数が上限（500万）を超えています。",
};

const PREFIX_FRIENDLY: Array<[string, (rest: string) => string]> = [
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
  // "Invalid xlsx (zip): <detail>" — security_scan when ZipArchive fails
  ["Invalid xlsx (zip):", (rest) => `xlsx として開けません。ZIP 構造が不正です（${rest.trim()}）`],
];

export function friendlyError(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const exact = FRIENDLY[raw];
  if (exact) return exact;
  for (const [prefix, fmt] of PREFIX_FRIENDLY) {
    if (raw.startsWith(prefix)) {
      return fmt(raw.slice(prefix.length));
    }
  }
  return raw;
}
