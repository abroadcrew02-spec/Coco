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
;
; POSTINSTALL / POSTUNINSTALL (below) register Nicel as an Explorer
; "Open with" candidate for .xlsx .xlsm .xls .csv .tsv (#418). They also
; depend on the 2.11.x template: `$UpdateMode`, `$INSTDIR`,
; `${MAINBINARYNAME}` and the position where POSTUNINSTALL is invoked (at
; the very end of `Section Uninstall`, after the running-app check). Re-run
; S3 in docs/STATE.md after upgrading the Tauri CLI.
;
; This file is included BEFORE the template defines MAINBINARYNAME, so
; `${MAINBINARYNAME}` may only appear inside macro bodies (expanded when the
; macro is inserted), never in a top-level !define.
;
; The extension list below must stay the same set as LAUNCH_EXTENSIONS in
; src-tauri/src/commands/launch.rs; a Rust test compares the two.

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

; --- Explorer "Open with" registration (#418) ------------------------------
;
; Everything is written under HKCU. Nicel is only offered as a candidate: the
; default value of HKCU\Software\Classes\<ext>, the UserChoice key and HKLM
; are never touched, so the app a user has chosen for a file type (for
; example Excel) stays the default. Do not add `bundle.fileAssociations` to
; tauri.conf.json: the template's APP_ASSOCIATE would overwrite the default
; value of the extension keys.
;
; Values under OpenWithProgids and SupportedTypes are written as empty
; REG_SZ (the bundled NSIS has no WriteRegNone); the shell only reads the
; value names.

!define NICEL_PROGID "Nicel.Workbook"
!define NICEL_CAPABILITIES_KEY "Software\Nicel\Capabilities"

!macro NICEL_OPENWITH_ADD EXT
  WriteRegStr HKCU "Software\Classes\${EXT}\OpenWithProgids" "${NICEL_PROGID}" ""
  WriteRegStr HKCU "Software\Classes\Applications\${MAINBINARYNAME}.exe\SupportedTypes" "${EXT}" ""
  WriteRegStr HKCU "${NICEL_CAPABILITIES_KEY}\FileAssociations" "${EXT}" "${NICEL_PROGID}"
!macroend

; Removes only Nicel's value. The OpenWithProgids key itself and the values
; of other applications (Excel.Sheet.12, ...) are left alone.
!macro NICEL_OPENWITH_REMOVE EXT
  DeleteRegValue HKCU "Software\Classes\${EXT}\OpenWithProgids" "${NICEL_PROGID}"
!macroend

; Runs on every install, including /UPDATE (the template does not run the old
; uninstaller during an update, so the registration is simply rewritten).
!macro NSIS_HOOK_POSTINSTALL
  ; ProgID
  WriteRegStr HKCU "Software\Classes\${NICEL_PROGID}" "" "Nicel Workbook"
  WriteRegStr HKCU "Software\Classes\${NICEL_PROGID}\DefaultIcon" "" '"$INSTDIR\${MAINBINARYNAME}.exe",0'
  WriteRegStr HKCU "Software\Classes\${NICEL_PROGID}\shell\open\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'

  ; Applications\<exe> (lets the "Open with" list resolve a name and icon)
  WriteRegStr HKCU "Software\Classes\Applications\${MAINBINARYNAME}.exe" "FriendlyAppName" "Nicel"
  WriteRegStr HKCU "Software\Classes\Applications\${MAINBINARYNAME}.exe\shell\open\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'

  ; Capabilities (lists Nicel under Settings > Default apps)
  WriteRegStr HKCU "${NICEL_CAPABILITIES_KEY}" "ApplicationName" "Nicel"
  WriteRegStr HKCU "${NICEL_CAPABILITIES_KEY}" "ApplicationDescription" "Spreadsheet editor for xlsx, xls, csv and tsv files"

  !insertmacro NICEL_OPENWITH_ADD ".xlsx"
  !insertmacro NICEL_OPENWITH_ADD ".xlsm"
  !insertmacro NICEL_OPENWITH_ADD ".xls"
  !insertmacro NICEL_OPENWITH_ADD ".csv"
  !insertmacro NICEL_OPENWITH_ADD ".tsv"

  WriteRegStr HKCU "Software\RegisteredApplications" "Nicel" "${NICEL_CAPABILITIES_KEY}"

  ; SHCNE_ASSOCCHANGED, SHCNF_IDLIST. Not SHCNF_FLUSH (0x1000): that waits
  ; until every listener has handled the event, and the auto-updater runs
  ; this installer unattended (/P), where a hung listener would stall it.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

; POSTUNINSTALL, not PREUNINSTALL: the template asks "Nicel is running" right
; after PREUNINSTALL and aborts on Cancel, which would leave the app installed
; with its registration already gone. This point is reached only when the
; uninstall ran to the end.
!macro NSIS_HOOK_POSTUNINSTALL
  ; Not on the /UPDATE path (a newer template might run the uninstaller
  ; during an update; the registration must survive that).
  ${If} $UpdateMode <> 1
    Push $R0
    ; Remove only what this installation registered: another per-user copy
    ; installed elsewhere may own the ProgID now.
    ReadRegStr $R0 HKCU "Software\Classes\${NICEL_PROGID}\shell\open\command" ""
    ${If} $R0 == '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'
      !insertmacro NICEL_OPENWITH_REMOVE ".xlsx"
      !insertmacro NICEL_OPENWITH_REMOVE ".xlsm"
      !insertmacro NICEL_OPENWITH_REMOVE ".xls"
      !insertmacro NICEL_OPENWITH_REMOVE ".csv"
      !insertmacro NICEL_OPENWITH_REMOVE ".tsv"
      DeleteRegKey HKCU "Software\Classes\${NICEL_PROGID}"
      DeleteRegKey HKCU "Software\Classes\Applications\${MAINBINARYNAME}.exe"
      DeleteRegValue HKCU "Software\RegisteredApplications" "Nicel"
      DeleteRegKey HKCU "${NICEL_CAPABILITIES_KEY}"
      ; Software\Nicel goes only when nothing else (the template's
      ; install-location key) is left in it.
      DeleteRegKey /ifempty HKCU "Software\Nicel"
      System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
    ${EndIf}
    Pop $R0
  ${EndIf}
!macroend
