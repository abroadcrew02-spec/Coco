// Rust emits recovery `reason` codes verbatim ("auto_save", "manual_save", "backup",
// "crash"). The home screen used to render the raw code, which leaked snake_case
// jargon into the UI. This helper centralizes the translation so the same label
// can be reused if we surface reasons elsewhere (snapshot list, audit log).

export function recoveryReasonLabel(reason: string): string {
  switch (reason) {
    case "auto_save":
      return "自動保存";
    case "manual_save":
      return "手動保存";
    case "backup":
      return "バックアップ";
    case "crash":
      return "クラッシュ復元";
    default:
      return reason;
  }
}
