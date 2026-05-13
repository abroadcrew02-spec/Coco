// Tiny shell-out helpers for OS-native file-manager integration.
// Kept self-contained (no plugin dependency) so the surface stays minimal.

use std::path::Path;
use std::process::Command;

/// Returns the platform-appropriate command for "open the containing folder
/// and select this file", or an error if the path is invalid.
///
/// - Windows: `explorer.exe /select,<path>` (highlights the file).
/// - macOS:   `open -R <path>` (Reveal in Finder).
/// - Linux:   `xdg-open <parent_dir>` — there is no portable file-select on
///            Linux, so the best we can do is open the containing folder.
pub fn reveal_in_file_manager_core(path: &str) -> Result<(), String> {
    let p = Path::new(path);
    if path.is_empty() {
        return Err("REVEAL_EMPTY_PATH".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        // /select,<path> highlights the file in Explorer; works for paths
        // with spaces because Windows parses the argument list itself.
        let status = Command::new("explorer.exe")
            .arg(format!("/select,{}", p.display()))
            .spawn()
            .map_err(|e| format!("REVEAL_SPAWN_FAILED: {}", e))?
            .wait();
        // explorer.exe returns 1 even on success in many configurations; do
        // not treat a non-zero exit as a hard failure unless spawn itself
        // errored.
        let _ = status;
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg("-R")
            .arg(p)
            .spawn()
            .map_err(|e| format!("REVEAL_SPAWN_FAILED: {}", e))?;
        return Ok(());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let parent = p.parent().unwrap_or_else(|| Path::new("."));
        Command::new("xdg-open")
            .arg(parent)
            .spawn()
            .map_err(|e| format!("REVEAL_SPAWN_FAILED: {}", e))?;
        return Ok(());
    }
}

#[tauri::command]
pub fn reveal_in_file_manager(path: String) -> Result<(), String> {
    reveal_in_file_manager_core(&path)
}
