// Rust emits recovery `reason` codes verbatim. As of #104 the Rust side
// only emits "auto_save" (recovery.rs) and "manual_save" (workbook.rs) — the
// "backup" / "crash" codes documented earlier are not produced by any path
// today, so we don't carry phantom labels. New codes added on the Rust side
// should be added here in lockstep; until then the `default` falls through
// to the raw code, which is at least debuggable.

export function recoveryReasonLabel(reason: string): string {
  switch (reason) {
    case "auto_save":
      return "自動保存";
    case "manual_save":
      return "手動保存";
    default:
      return reason;
  }
}
