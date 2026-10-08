//! Files named on the process command line (Explorer "Open with" runs
//! `"<exe>" "%1"`). The frontend asks for them once at startup.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Extensions accepted from the command line. Must stay the same set as the
/// NICEL_OPENWITH_ADD / NICEL_OPENWITH_REMOVE lines in
/// src-tauri/windows/hooks.nsh (checked by tests/launch_paths.rs).
pub const LAUNCH_EXTENSIONS: [&str; 5] = ["xlsx", "xlsm", "xls", "csv", "tsv"];

/// Files named on this process's command line, handed to the frontend once.
#[derive(Default)]
pub struct LaunchPaths {
    pending: Mutex<Vec<PathBuf>>,
}

impl LaunchPaths {
    /// Filters by extension and makes relative paths absolute against `cwd`.
    /// Does not touch the filesystem.
    pub fn from_args<I, S>(args: I, cwd: &Path) -> Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        Self {
            pending: Mutex::new(launch_candidates(args, cwd)),
        }
    }

    /// Empties the list. Later calls return an empty Vec. Does not touch the
    /// filesystem, so it is cheap to call from async code.
    pub fn take_pending(&self) -> Vec<PathBuf> {
        let mut guard = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        std::mem::take(&mut *guard)
    }

    /// Empties the list and returns, in argv order, the entries that are
    /// existing regular files with a UTF-8 representation. Later calls
    /// return an empty Vec. Blocks on filesystem access.
    pub fn take_existing(&self) -> Vec<String> {
        existing_files(self.take_pending())
    }
}

/// Keeps the entries that are existing regular files and can be handed to the
/// frontend as a string. Blocks on filesystem access (a disconnected network
/// path can take a long time).
pub fn existing_files(candidates: Vec<PathBuf>) -> Vec<String> {
    let total = candidates.len();
    let found: Vec<String> = candidates
        .into_iter()
        .filter(|p| std::fs::metadata(p).map(|m| m.is_file()).unwrap_or(false))
        .filter_map(|p| p.to_str().map(str::to_owned))
        .collect();
    // Counts only: the logger is set up by the log plugin after the command
    // line is parsed, and paths stay out of the log.
    if total > 0 {
        log::info!(
            "launch: {} path(s) on the command line, {} usable",
            total,
            found.len()
        );
    }
    found
}

/// Pure. Public for tests.
///
/// Returns the arguments whose extension (case-insensitive) is one of
/// `LAUNCH_EXTENSIONS`, in order. Relative paths are joined onto `cwd`.
/// Switches such as `/UPDATE`, `/P` or `--flag` have no such extension and
/// drop out.
pub fn launch_candidates<I, S>(args: I, cwd: &Path) -> Vec<PathBuf>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    args.into_iter()
        .filter_map(|arg| {
            let arg = arg.as_ref();
            if arg.is_empty() {
                return None;
            }
            let path = Path::new(arg);
            let ext = path.extension()?.to_str()?.to_ascii_lowercase();
            if !LAUNCH_EXTENSIONS.contains(&ext.as_str()) {
                return None;
            }
            Some(if path.is_absolute() {
                path.to_path_buf()
            } else {
                cwd.join(path)
            })
        })
        .collect()
}

/// Returns the files named on the command line that exist, once per process.
/// Every later call returns an empty list, so reloading the WebView never
/// reopens the launch file.
#[tauri::command]
pub async fn take_launch_paths(
    state: tauri::State<'_, LaunchPaths>,
) -> Result<Vec<String>, String> {
    let pending = state.take_pending();
    if pending.is_empty() {
        return Ok(Vec::new());
    }
    // The existence check can block on an unreachable network path; keep it
    // off the async worker threads.
    match tauri::async_runtime::spawn_blocking(move || existing_files(pending)).await {
        Ok(found) => Ok(found),
        Err(e) => {
            log::warn!("launch: existence check did not finish: {}", e);
            Ok(Vec::new())
        }
    }
}
