; NSIS installer hooks (Tauri v2 `bundle.windows.nsis.installerHooks`).
;
; The product was renamed from "Coco" to "Nicel" in v0.8.0. Tauri's NSIS
; template derives the install directory, the Add/Remove Programs entry and
; the Start-menu shortcuts from productName, so an in-place update would
; otherwise leave the old "Coco" installation next to the new one (two
; entries in Add/Remove Programs, the old shortcut still launching v0.7.x).
;
; Before installing, look for the legacy per-user entry and run its
; uninstaller silently. App data is untouched: it lives under the bundle
; identifier (com.coco.app), which did not change, and the Tauri uninstaller
; only deletes app data when the user ticks the checkbox on its confirm page
; (never shown in silent mode). Only HKCU is handled: the installer runs
; per-user and cannot remove a per-machine (HKLM / MSI) entry without
; elevation.
;
; Depends on internals of the Tauri CLI 2.11.x NSIS template: LogicLib +
; FileFunc are already included, `CheckIfAppIsRunning` is the template's
; macro, and `$UpdateMode` is its flag for the `/UPDATE` switch (always
; passed by the auto-updater). Re-run the upgrade test (S2 in docs/STATE.md)
; after upgrading the Tauri CLI.

!define NICEL_LEGACY_UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\Coco"

!macro NSIS_HOOK_PREINSTALL
  Push $R0
  Push $R1
  Push $R2
  Push $R3

  ReadRegStr $R0 HKCU "${NICEL_LEGACY_UNINSTKEY}" "UninstallString"
  ${If} $R0 != ""
    ; "Coco" is a generic name: only act on an entry that the pre-rename
    ; Tauri installer wrote (it records these two values). Anything else
    ; registered under the same key is somebody else's software and is
    ; left alone, including its registry key.
    ReadRegStr $R2 HKCU "${NICEL_LEGACY_UNINSTKEY}" "MainBinaryName"
    ReadRegStr $R3 HKCU "${NICEL_LEGACY_UNINSTKEY}" "Publisher"
    ${If} $R2 == "coco.exe"
    ${AndIf} $R3 == "coco"
      ; A manual (GUI) install while Coco is still open: ask before the
      ; legacy uninstaller kills it (its silent run would otherwise
      ; terminate coco.exe without warning and drop unsaved edits). The
      ; template macro prompts in GUI mode and kills without asking in
      ; passive / silent mode, which is the auto-update path where Coco
      ; has already exited. It clobbers $R0-$R3, so the values are read
      ; again afterwards.
      !insertmacro CheckIfAppIsRunning "coco.exe" "Coco"

      ; UninstallString / InstallLocation are stored quoted; strip the quotes.
      ReadRegStr $R0 HKCU "${NICEL_LEGACY_UNINSTKEY}" "UninstallString"
      StrCpy $R2 $R0 1
      ${If} $R2 == '"'
        StrCpy $R0 $R0 -1 1
      ${EndIf}
      ReadRegStr $R1 HKCU "${NICEL_LEGACY_UNINSTKEY}" "InstallLocation"
      StrCpy $R2 $R1 1
      ${If} $R2 == '"'
        StrCpy $R1 $R1 -1 1
      ${EndIf}
      ${If} $R1 == ""
        ; Tauri always writes InstallLocation; fall back to the uninstaller's
        ; directory so `_?=` is never empty (an empty `_?=` makes the
        ; uninstaller copy itself to %TEMP% and return before finishing).
        ${GetParent} $R0 $R1
      ${EndIf}

      ${If} $R0 != "$R1\uninstall.exe"
        ; The uninstaller must be the one inside the recorded install dir;
        ; refuse to run anything else that was planted in the entry.
        DetailPrint "Legacy Coco entry does not point at its own uninstaller ($R0); leaving it alone"
      ${ElseIfNot} ${FileExists} "$R0"
        ; Stale entry (uninstall.exe already gone): nothing to run. Drop the
        ; key so the migration does not re-trigger on every later update.
        DetailPrint "Legacy Coco uninstaller not found at $R0; removing stale entry"
        DeleteRegKey HKCU "${NICEL_LEGACY_UNINSTKEY}"
      ${Else}
        DetailPrint "Removing legacy Coco installation from $R1"
        ; `_?=` keeps the uninstaller in place (no temp copy) so ExecWait
        ; blocks until it has finished; the uninstaller then cannot delete
        ; itself, so clean up the leftover file and (non-recursively) the
        ; empty folder. ExecWait leaves the exit-code variable undefined
        ; when the process could not be started, hence the error flag.
        ClearErrors
        ExecWait '"$R0" /S _?=$R1' $R2
        ${If} ${Errors}
          DetailPrint "Legacy Coco uninstaller could not be started; keeping its entry for a retry"
        ${ElseIf} $R2 == 0
          Delete "$R1\uninstall.exe"
          RMDir "$R1"
          DeleteRegKey HKCU "${NICEL_LEGACY_UNINSTKEY}"
        ${Else}
          ; Keep the legacy entry so the next install attempt retries the
          ; migration instead of silently leaving coco.exe behind.
          DetailPrint "Legacy Coco uninstaller exited with code $R2; keeping its entry for a retry"
        ${EndIf}
      ${EndIf}

      ; The legacy uninstaller removed the Coco Start-menu / desktop
      ; shortcuts (and taskbar pins). In update mode the template skips
      ; creating shortcuts, which would leave the user with no way to launch
      ; the app after the update, so clear the flag and let the template
      ; create the Nicel shortcuts. Done even when the uninstaller failed:
      ; two icons are safer than none.
      StrCpy $UpdateMode 0
    ${EndIf}
  ${EndIf}

  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
!macroend
