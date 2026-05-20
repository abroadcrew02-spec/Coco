# Cross-Platform Build Preflight (requirements.md §12.3)

Audit conducted 2026-05-14 against `main` on Windows. The Windows build is shipping fine; this document records what was inspected for macOS Intel / macOS Apple Silicon readiness ahead of the first cross-platform build attempt.

OS test matrix per requirements.md §12.3:

- Windows 10 / 11 x64 (currently shipping)
- macOS 12 Intel
- macOS 12+ Apple Silicon

## Scope

- `src-tauri/tauri.conf.json`
- `src-tauri/Cargo.toml`
- `src-tauri/src/main.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/commands/*.rs`, `src-tauri/src/db/*.rs`
- `package.json` scripts
- `scripts/pack-distbin.mjs`
- `vite.config.ts`
- Frontend keyboard handling (`src/hooks/useGlobalShortcuts.ts` etc.)
- Bundle icons under `src-tauri/icons/`

## Severity legend

- **BLOCKER** — build will not produce output on macOS/Linux (e.g. unconditional Windows-only import).
- **WARNING** — build succeeds but runtime behavior diverges on the non-Windows target.
- **NOTE** — stylistic / non-critical.

## Findings

### BLOCKERS

None.

All Rust dependencies (`rusqlite` with `bundled`, `zip` deflate-only, `calamine`, `rust_xlsxwriter`, `csv`, `encoding_rs`, `chrono`, `serde`, `uuid`, `thiserror`, `tauri`, `tauri-plugin-dialog`) are portable across Windows / macOS / Linux. No `cfg(windows)` gated import is unconditionally required elsewhere.

All OS-specific code paths in `src-tauri/src/commands/shell.rs` (the only file with platform `cfg`) are exhaustively gated for the three target platforms.

### WARNINGs

1. **`src-tauri/tauri.conf.json` — `bundle.macOS.minimumSystemVersion` set to `12.0` (RESOLVED 2026-05-15, issue #60).**
   - Resolution: `tauri.conf.json` now declares `bundle.macOS.minimumSystemVersion = "12.0"`, matching §12.3's "macOS 12+" target. No further action required.
   - Historical context: this entry was previously listed as a WARNING because the field was missing; left here so the audit trail stays intact.

2. **`src-tauri/tauri.conf.json` — no `bundle.macOS.signingIdentity`, `entitlements`, or hardened-runtime config.**
   - What breaks: unsigned `.dmg` will produce a Gatekeeper warning on macOS. Requirements.md §3.1 explicitly calls out "署名済みmacOS `.dmg` による社内配布" so signing must be added before first internal distribution. Build itself will still succeed.
   - Suggested fix: add signing/notarization config once Apple Developer credentials are available; out of scope for this audit.

### NOTEs

1. **`vite.config.ts:57` — `target: process.env.TAURI_ENV_PLATFORM == "windows" ? "chrome105" : "safari13"`.**
   - Safari 13 is more conservative than macOS 12 (which ships Safari 15). Fine, just leaves some perf on the table for newer Safari WebKit. No action.

2. **`package.json:36` — `"vue": "^3.5.34"` listed as direct dependency.**
   - Not OS-related; this is a React app so Vue is presumably a transitive Univer requirement that got hoisted. Cross-platform-neutral.

3. **`scripts/pack-distbin.mjs`** — uses `node:path` `join()` and walks `src-tauri/target/release/bundle/` generically; already discovers `.dmg`, `.app`, `.deb`, `.AppImage`, `.rpm` siblings. No changes needed.

4. **`src-tauri/icons/`** — contains `icon.icns` (macOS), `icon.ico` (Windows), `icon.png` (Linux). All present and non-empty. Good.

5. **`src-tauri/src/commands/csv_io.rs:339`** — CSV writer emits `\r\n` regardless of OS. This is intentional (RFC 4180 / Excel convention), not a Windows-ism.

6. **`src-tauri/src/commands/xlsx_io.rs:4366`** — `sanitize_sheet_name` strips `'\\' | '/'`. This is the Excel sheet-name rule, not a path-separator issue.

7. **`src-tauri/src/main.rs:1`** — `#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]`. The `windows_subsystem` attribute is silently ignored by rustc on non-Windows targets. No change needed.

## Honest estimate

A fresh macOS build (cargo + `npm run tauri build`) should **succeed** today and produce an unsigned `.dmg` + `.app`. Functional behavior should be equivalent to Windows for file I/O, autosave, recovery, xlsx/CSV round-trip, and reveal-in-Finder, because:

- All paths go through Tauri's `app.path().app_data_dir()` (portable).
- The only `Command::new(...)` calls are properly cfg-gated.
- Frontend shortcuts already accept both Ctrl and Cmd.
- All bundle icons are present.

Caveats before declaring "ready":

- The bundle will be unsigned and trigger Gatekeeper. Code signing is a §3.1 requirement before social distribution.

None of those block the first successful build; they block first *shippable* build.
