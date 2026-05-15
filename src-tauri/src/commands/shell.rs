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
/// `_hyperlinks` entry. We reject schemes other than http(s) and mailto.
/// The `file:` scheme is intentionally rejected (issue #63) because a
/// malicious workbook could otherwise launch arbitrary local/SMB executables
/// via the OS default handler (cf. CVE-2017-0199-style phishing). Users who
/// need to reach a local file can do so via the file manager.
pub fn open_url_core(url: &str) -> Result<(), String> {
    let trimmed = validate_open_url(url)?;

    #[cfg(target_os = "windows")]
    {
        shell_execute_open(trimmed)?;
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

fn validate_open_url(url: &str) -> Result<&str, String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err("OPEN_URL_EMPTY".to_string());
    }
    if trimmed.len() != url.len() {
        return Err("OPEN_URL_AMBIGUOUS".to_string());
    }
    if trimmed.chars().any(char::is_control) {
        return Err("OPEN_URL_CONTROL_CHAR".to_string());
    }

    let (scheme, rest) = trimmed
        .split_once(':')
        .ok_or_else(|| "OPEN_URL_DISALLOWED_SCHEME".to_string())?;
    if rest.is_empty() || !scheme.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err("OPEN_URL_AMBIGUOUS".to_string());
    }

    match scheme.to_ascii_lowercase().as_str() {
        "http" | "https" | "mailto" => Ok(trimmed),
        // file: removed (issue #63) — see open_url_core doc comment.
        _ => Err("OPEN_URL_DISALLOWED_SCHEME".to_string()),
    }
}

#[cfg(target_os = "windows")]
fn shell_execute_open(url: &str) -> Result<(), String> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use std::ptr::null;

    #[link(name = "shell32")]
    extern "system" {
        fn ShellExecuteW(
            hwnd: isize,
            lp_operation: *const u16,
            lp_file: *const u16,
            lp_parameters: *const u16,
            lp_directory: *const u16,
            n_show_cmd: i32,
        ) -> isize;
    }

    let operation: Vec<u16> = OsStr::new("open")
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let file: Vec<u16> = OsStr::new(url)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    let result = unsafe { ShellExecuteW(0, operation.as_ptr(), file.as_ptr(), null(), null(), 1) };
    if result <= 32 {
        Err(format!("OPEN_URL_SPAWN_FAILED: ShellExecuteW {}", result))
    } else {
        Ok(())
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
        assert_eq!(validate_open_url(""), Err("OPEN_URL_EMPTY".to_string()));
        assert_eq!(validate_open_url("   "), Err("OPEN_URL_EMPTY".to_string()));
    }

    #[test]
    fn rejects_disallowed_schemes() {
        assert!(validate_open_url("javascript:alert(1)").is_err());
        assert!(validate_open_url("data:text/html,<script>").is_err());
        // No scheme at all is also rejected.
        assert!(validate_open_url("example.com").is_err());
    }

    #[test]
    fn rejects_control_chars_and_ambiguous_urls() {
        assert_eq!(
            validate_open_url("https://example.com/\r\ncalc"),
            Err("OPEN_URL_CONTROL_CHAR".to_string())
        );
        assert_eq!(
            validate_open_url(" https://example.com"),
            Err("OPEN_URL_AMBIGUOUS".to_string())
        );
        assert_eq!(
            validate_open_url("https://example.com "),
            Err("OPEN_URL_AMBIGUOUS".to_string())
        );
    }

    #[test]
    fn accepts_http_and_https() {
        assert_eq!(
            validate_open_url("HTTP://EXAMPLE.COM").unwrap(),
            "HTTP://EXAMPLE.COM"
        );
        assert_eq!(
            validate_open_url("https://example.com").unwrap(),
            "https://example.com"
        );
    }
}
