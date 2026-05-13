// Workbook save status shown in title bar
export type SaveStatus =
  | "loading"
  | "import_warning"
  | "unsaved"
  | "saving"
  | "saved"
  | "auto_saved"
  | "save_failed"
  | "exporting"
  | "export_done"
  | "export_failed"
  | "recovery_available";

// Whether current workbook came from new/coco/xlsx
export type WorkbookSourceType = "new" | "coco" | "xlsx";

// Compatibility warning from xlsx import/export
export interface CompatibilityWarning {
  severity: "info" | "warning" | "blocking";
  code: string;
  message: string;
  affectedSheets?: string[];
}

// A recently used file entry
export interface RecentFile {
  path: string;
  name: string;
  lastOpened: string; // ISO datetime
  exists: boolean;
}

// A recovery candidate (auto-save or backup). Rust may emit reasons we don't
// yet know about (future migrations); use `string` so the UI's translator
// gets a chance to fall through to pass-through instead of TS rejecting the
// payload at the boundary.
export interface RecoveryCandidate {
  candidateId: string;
  originalPath: string | null;
  savedAt: string; // ISO datetime
  reason: string;
}

// Result of opening/creating a workbook
export interface WorkbookHandle {
  workbookId: string;
  path: string | null;
  sourceType: WorkbookSourceType;
  snapshotJson: string | null;
}

// Full open result with warnings
export interface OpenWorkbookResult {
  handle: WorkbookHandle;
  warnings: CompatibilityWarning[];
}

// Import result from xlsx
export interface ImportWorkbookResult {
  handle: WorkbookHandle;
  warnings: CompatibilityWarning[];
}

// Save result
export interface SaveResult {
  success: boolean;
  path: string;
  error?: string;
}

// Export result
export interface ExportResult {
  success: boolean;
  path: string;
  warnings: CompatibilityWarning[];
  error?: string;
}

// Security scan result for xlsx files (req 5.3.2)
export interface SecurityScanResult {
  safe: boolean;
  blocked: boolean;
  warnings: string[];
  issues: string[];
}

// Screen view
export type AppScreen = "home" | "editor";
