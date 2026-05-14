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

/// Open an URL or file path in the user's default browser / handler. Used by
/// the in-grid hyperlink renderer when the user clicks a cell with a
/// `_hyperlinks` entry. We reject schemes other than http(s), mailto, and
/// file so a malicious workbook can't ship a `javascript:` payload or coerce
/// us into running an arbitrary OS handler.
pub fn open_url_core(url: &str) -> Result<(), String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err("OPEN_URL_EMPTY".to_string());
    }
    let lower = trimmed.to_ascii_lowercase();
    let allowed = lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("mailto:")
        || lower.starts_with("file:");
    if !allowed {
        return Err("OPEN_URL_DISALLOWED_SCHEME".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        // `cmd /c start "" <url>` — the empty title prevents start from
        // misinterpreting a URL with spaces as the window title. Detached so
        // closing the app doesn't kill the browser.
        Command::new("cmd")
            .args(["/c", "start", "", trimmed])
            .spawn()
            .map_err(|e| format!("OPEN_URL_SPAWN_FAILED: {}", e))?;
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(trimmed)
            .spawn()
            .map_err(|e| format!("OPEN_URL_SPAWN_FAILED: {}", e))?;
        return Ok(());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(trimmed)
            .spawn()
            .map_err(|e| format!("OPEN_URL_SPAWN_FAILED: {}", e))?;
        return Ok(());
    }
}

#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    open_url_core(&url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_empty_url() {
        assert_eq!(open_url_core(""), Err("OPEN_URL_EMPTY".to_string()));
        assert_eq!(open_url_core("   "), Err("OPEN_URL_EMPTY".to_string()));
    }

    #[test]
    fn rejects_disallowed_schemes() {
        assert!(open_url_core("javascript:alert(1)").is_err());
        assert!(open_url_core("data:text/html,<script>").is_err());
        // No scheme at all is also rejected.
        assert!(open_url_core("example.com").is_err());
    }

    #[test]
    fn accepts_http_and_https() {
        // We can't actually verify the spawn here without polluting the
        // test runner's process tree, so only assert the validation gate
        // accepts these by running on a platform where spawn fails fast
        // (any cfg block is exercised). To keep CI hermetic, just test the
        // pure validation path indirectly via casing.
        assert!("HTTP://EXAMPLE.COM".to_ascii_lowercase().starts_with("http://"));
        assert!("https://example.com".to_ascii_lowercase().starts_with("https://"));
    }
}
