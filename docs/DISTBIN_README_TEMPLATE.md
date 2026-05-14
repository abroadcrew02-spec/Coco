# Coco — distribution artifacts

This directory is produced by `npm run pack` (which invokes `tauri build` and then `scripts/pack-distbin.mjs`). It contains the redistributable build artifacts for the current Coco release, plus a SHA-256 checksum file and a JSON manifest.

This README is regenerated on every `npm run pack` run. Do not edit by hand — edit `docs/DISTBIN_README_TEMPLATE.md` instead.

## Files you may see here

The script copies whichever artifacts Tauri produced on the host platform. On a typical Windows release build:

| File | Purpose | When to use |
| ---- | ------- | ----------- |
| `Coco_<version>_x64_en-US.msi` | Windows MSI installer (WiX) | Standard managed-deployment install. Works with Group Policy / Intune / SCCM. |
| `Coco_<version>_x64-setup.exe` | Windows NSIS installer | Lightweight per-user install for individual workstations. |
| `Coco.exe` (or `coco.exe`) | Raw application executable | Run portably without installing. Used by QA for reproducing issues. |

On macOS the script will instead stage `Coco_<version>_x64.dmg` and on Linux it will stage `.deb`, `.rpm`, or `.AppImage` depending on what bundlers ran.

In every case the directory also contains:

- `SHA256SUMS.txt` — one `<sha256>  <filename>` line per artifact, in the standard `sha256sum -c` format.
- `manifest.json` — machine-readable inventory (`generatedAt`, `artifacts[].file`, `kind`, `sha256`, `bytes`).
- `README.md` — this file.

## What installs where (Windows)

The MSI and NSIS installers both lay down the same payload, just with different installer mechanics:

- **Program files**: `%ProgramFiles%\Coco\` (MSI default) or `%LocalAppData%\Programs\Coco\` (NSIS per-user default).
- **Start menu shortcut**: `Coco`.
- **User data**: created lazily under `%AppData%\Coco\` on first launch. Recents, settings, and recovery candidates live here.
- **Backups**: `.bak.1`..`.bak.5` are written next to the user's own `.xlsx` / `.coco` files, not under `%AppData%`.

Uninstalling Coco does **not** delete user data per requirements.md §5.6.

## Verifying SHA-256 checksums

### Windows (PowerShell)

```powershell
Get-FileHash .\Coco_<version>_x64_en-US.msi -Algorithm SHA256
# compare the Hash field against the matching line in SHA256SUMS.txt
```

Or, to verify every file in one shot using a checksum tool that understands the `sha256sum` format:

```powershell
# Requires the GNU coreutils `sha256sum` on PATH (e.g. via Git for Windows).
sha256sum -c SHA256SUMS.txt
```

### macOS / Linux

```sh
sha256sum -c SHA256SUMS.txt    # Linux
shasum -a 256 -c SHA256SUMS.txt # macOS
```

Every line should report `OK`. If a line reports `FAILED`, the artifact is corrupt or tampered with — do not install it.

## Signing

Release builds are expected to be Authenticode-signed on Windows and signed + notarized on macOS. Unsigned artifacts may appear here during development — they are useful for QA but must not be deployed to end users.

## Reproducibility

Each `npm run pack` invocation:

1. Runs `tauri build` (which invokes `cargo build --release` and the configured bundlers).
2. Clears `./distbin/`.
3. Copies fresh artifacts.
4. Recomputes SHA-256.
5. Regenerates `manifest.json` with the current UTC timestamp under `generatedAt`.
6. Regenerates this `README.md` from `docs/DISTBIN_README_TEMPLATE.md`.

If you need to re-stage without rebuilding (e.g. after editing the template), run `npm run pack:stage`.
