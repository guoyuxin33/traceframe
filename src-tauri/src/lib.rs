use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use std::collections::HashSet;
use std::env;
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;

const MAX_TREE_ENTRIES: usize = 800;
const MAX_TREE_DEPTH: usize = 6;
const MAX_FILE_PREVIEW_BYTES: usize = 512 * 1024;
const MAX_FILE_PREVIEW_LINES: usize = 4_000;
const MAX_GIT_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
const MAX_GIT_ERROR_BYTES: usize = 64 * 1024;
const MAX_DIFF_OUTPUT_BYTES: usize = 2 * 1024 * 1024;
const MAX_DIFF_OUTPUT_LINES: usize = 4_000;

#[derive(Default)]
struct WorkspaceAccessInner {
    roots: HashSet<PathBuf>,
    recent: Option<PathBuf>,
    store_path: Option<PathBuf>,
}

#[derive(Default)]
struct WorkspaceAccess {
    inner: Mutex<WorkspaceAccessInner>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeCapabilities {
    platform: String,
    arch: String,
    git_available: bool,
    shell: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GitFileState {
    path: String,
    index_status: String,
    worktree_status: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GitSnapshot {
    branch: String,
    ahead: u32,
    behind: u32,
    files: Vec<GitFileState>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceTreeEntry {
    path: String,
    name: String,
    kind: String,
    depth: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceTree {
    entries: Vec<WorkspaceTreeEntry>,
    truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceFile {
    path: String,
    content: String,
    size: u64,
    truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CcSwitchProvider {
    id: String,
    name: String,
    app_type: String,
    is_current: bool,
    in_failover_queue: bool,
    endpoint: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CcSwitchStatus {
    installed: bool,
    database_found: bool,
    proxy_enabled: bool,
    proxy_port: u16,
    providers: Vec<CcSwitchProvider>,
}

fn canonical_workspace(path: &str) -> Result<PathBuf, String> {
    let workspace = Path::new(path)
        .canonicalize()
        .map_err(|error| format!("Workspace is unavailable: {error}"))?;

    if !workspace.is_dir() {
        return Err("Workspace path is not a directory".into());
    }

    Ok(workspace)
}

impl WorkspaceAccess {
    fn load_recent(&self, store_path: PathBuf) -> Result<(), String> {
        let recent = fs::read_to_string(&store_path)
            .ok()
            .and_then(|stored| serde_json::from_str::<String>(&stored).ok())
            .and_then(|path| canonical_workspace(&path).ok());
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "Workspace access state is unavailable".to_string())?;
        inner.store_path = Some(store_path);
        if let Some(workspace) = recent {
            inner.roots.insert(workspace.clone());
            inner.recent = Some(workspace);
        }
        Ok(())
    }

    fn register(&self, workspace: PathBuf) -> Result<(), String> {
        let (store_path, serialized) = {
            let mut inner = self
                .inner
                .lock()
                .map_err(|_| "Workspace access state is unavailable".to_string())?;
            inner.roots.insert(workspace.clone());
            inner.recent = Some(workspace.clone());
            let serialized = serde_json::to_string(&workspace.to_string_lossy().to_string())
                .map_err(|error| format!("Recent workspace could not be encoded: {error}"))?;
            (inner.store_path.clone(), serialized)
        };

        if let Some(store_path) = store_path {
            if let Some(parent) = store_path.parent() {
                fs::create_dir_all(parent).map_err(|error| {
                    format!("Recent workspace directory could not be created: {error}")
                })?;
            }
            fs::write(store_path, serialized)
                .map_err(|error| format!("Recent workspace could not be saved: {error}"))?;
        }
        Ok(())
    }

    fn recent(&self) -> Result<Option<String>, String> {
        let inner = self
            .inner
            .lock()
            .map_err(|_| "Workspace access state is unavailable".to_string())?;
        Ok(inner
            .recent
            .as_ref()
            .map(|path| path.to_string_lossy().to_string()))
    }

    fn resolve(&self, path: &str) -> Result<PathBuf, String> {
        let workspace = canonical_workspace(path)?;
        let inner = self
            .inner
            .lock()
            .map_err(|_| "Workspace access state is unavailable".to_string())?;
        if !inner.roots.contains(&workspace) {
            return Err("Workspace access has not been authorized by the native picker".into());
        }
        Ok(workspace)
    }
}

fn safe_relative_path(path: &str) -> Result<PathBuf, String> {
    let relative = Path::new(path);
    if path.is_empty()
        || relative.is_absolute()
        || relative.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err("Workspace file path is invalid".into());
    }

    Ok(relative.to_path_buf())
}

fn display_relative(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn should_skip_directory(name: &str) -> bool {
    matches!(
        name,
        ".git"
            | "node_modules"
            | "target"
            | "dist"
            | "build"
            | ".next"
            | ".turbo"
            | "coverage"
            | "vendor"
    )
}

fn collect_workspace_tree(
    root: &Path,
    directory: &Path,
    depth: usize,
    entries: &mut Vec<WorkspaceTreeEntry>,
) -> Result<bool, String> {
    if entries.len() >= MAX_TREE_ENTRIES {
        return Ok(true);
    }

    let mut children = fs::read_dir(directory)
        .map_err(|error| format!("Workspace directory could not be read: {error}"))?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let file_type = entry.file_type().ok()?;
            if file_type.is_symlink() {
                return None;
            }
            Some((entry, file_type))
        })
        .collect::<Vec<_>>();

    children.sort_by(|(left, left_type), (right, right_type)| {
        right_type.is_dir().cmp(&left_type.is_dir()).then_with(|| {
            left.file_name()
                .to_string_lossy()
                .to_lowercase()
                .cmp(&right.file_name().to_string_lossy().to_lowercase())
        })
    });

    let mut truncated = false;
    for (index, (entry, file_type)) in children.iter().enumerate() {
        if entries.len() >= MAX_TREE_ENTRIES {
            truncated = index < children.len();
            break;
        }

        let name = entry.file_name().to_string_lossy().to_string();
        if file_type.is_dir() && should_skip_directory(&name) {
            continue;
        }

        let path = entry.path();
        let relative = path
            .strip_prefix(root)
            .map_err(|error| format!("Workspace entry is outside the root: {error}"))?;
        entries.push(WorkspaceTreeEntry {
            path: display_relative(relative),
            name,
            kind: if file_type.is_dir() {
                "directory"
            } else {
                "file"
            }
            .into(),
            depth,
        });

        if file_type.is_dir() {
            if depth >= MAX_TREE_DEPTH {
                truncated |= fs::read_dir(&path)
                    .map(|mut children| children.next().is_some())
                    .unwrap_or(false);
            } else {
                truncated |= collect_workspace_tree(root, &path, depth + 1, entries)?;
            }
        }
    }

    Ok(truncated)
}

fn parse_git_snapshot(status: &str) -> GitSnapshot {
    let nul_terminated = status.contains('\0');
    let records = if nul_terminated {
        status.split_terminator('\0').collect::<Vec<_>>()
    } else {
        status.lines().collect::<Vec<_>>()
    };
    let branch_line = records.first().copied().unwrap_or("## HEAD");
    let branch_header = branch_line.trim_start_matches("## ");
    let mut branch = branch_header
        .strip_prefix("No commits yet on ")
        .unwrap_or(branch_header)
        .split("...")
        .next()
        .unwrap_or("HEAD")
        .split(" [")
        .next()
        .unwrap_or("HEAD")
        .to_owned();
    if branch == "HEAD (no branch)" {
        branch = "HEAD".into();
    }
    let ahead = branch_line
        .split("ahead ")
        .nth(1)
        .and_then(|value| value.split([',', ']']).next())
        .and_then(|value| value.parse().ok())
        .unwrap_or(0);
    let behind = branch_line
        .split("behind ")
        .nth(1)
        .and_then(|value| value.split([',', ']']).next())
        .and_then(|value| value.parse().ok())
        .unwrap_or(0);
    let mut files = Vec::new();
    let mut index = 1;
    while index < records.len() {
        let line = records[index];
        index += 1;
        if line.len() < 3 {
            continue;
        }
        let index_status = line[0..1].to_owned();
        let worktree_status = line[1..2].to_owned();
        let path = if nul_terminated {
            line[3..].to_owned()
        } else {
            line[3..]
                .rsplit_once(" -> ")
                .map(|(_, destination)| destination)
                .unwrap_or(&line[3..])
                .trim_matches('"')
                .to_owned()
        };
        if nul_terminated
            && (matches!(index_status.as_str(), "R" | "C")
                || matches!(worktree_status.as_str(), "R" | "C"))
        {
            index += 1;
        }
        files.push(GitFileState {
            index_status,
            worktree_status,
            path,
        });
    }

    GitSnapshot {
        branch,
        ahead,
        behind,
        files,
    }
}

fn run_git(path: &Path, args: &[&str]) -> Result<String, String> {
    run_git_limited(path, args, MAX_GIT_OUTPUT_BYTES, "Git output")
}

fn run_git_limited(
    path: &Path,
    args: &[&str],
    max_bytes: usize,
    label: &str,
) -> Result<String, String> {
    let mut child = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Git could not be started: {error}"))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Git output could not be captured".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Git error output could not be captured".to_string())?;
    let stdout_reader = std::thread::spawn(move || {
        let mut bytes = Vec::with_capacity(max_bytes.min(64 * 1024));
        stdout
            .take((max_bytes + 1) as u64)
            .read_to_end(&mut bytes)
            .map(|_| bytes)
    });
    let stderr_reader = std::thread::spawn(move || {
        let mut bytes = Vec::with_capacity(8 * 1024);
        stderr
            .take((MAX_GIT_ERROR_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .map(|_| bytes)
    });
    let status = child
        .wait()
        .map_err(|error| format!("Git command could not be completed: {error}"))?;
    let bytes = stdout_reader
        .join()
        .map_err(|_| "Git output reader stopped unexpectedly".to_string())?
        .map_err(|error| format!("Git output could not be read: {error}"))?;
    let error_bytes = stderr_reader
        .join()
        .map_err(|_| "Git error reader stopped unexpectedly".to_string())?
        .map_err(|error| format!("Git error output could not be read: {error}"))?;

    if bytes.len() > max_bytes {
        return Err(format!(
            "{label} exceeds the {max_bytes} byte preview limit"
        ));
    }
    if error_bytes.len() > MAX_GIT_ERROR_BYTES {
        return Err("Git error output exceeds the preview limit".into());
    }
    if !status.success() {
        return Err(String::from_utf8_lossy(&error_bytes).trim().to_owned());
    }

    Ok(String::from_utf8_lossy(&bytes).to_string())
}

#[tauri::command]
fn native_capabilities() -> NativeCapabilities {
    NativeCapabilities {
        platform: std::env::consts::OS.to_owned(),
        arch: std::env::consts::ARCH.to_owned(),
        git_available: Command::new("git").arg("--version").output().is_ok(),
        shell: std::env::var("SHELL").unwrap_or_else(|_| "unknown".into()),
    }
}

#[tauri::command]
fn pick_workspace(
    app: tauri::AppHandle,
    access: State<'_, WorkspaceAccess>,
) -> Result<Option<String>, String> {
    let selected = app
        .dialog()
        .file()
        .set_title("Open a Traceframe workspace")
        .blocking_pick_folder();

    let workspace = selected
        .map(|path| {
            let path = path
                .as_path()
                .ok_or_else(|| "Only local workspace folders are supported".to_string())?;
            canonical_workspace(&path.to_string_lossy())
                .map(|workspace| workspace.to_string_lossy().to_string())
        })
        .transpose()?;
    if let Some(workspace) = workspace.as_ref() {
        access.register(PathBuf::from(workspace))?;
    }
    Ok(workspace)
}

#[tauri::command]
fn recent_workspace(access: State<'_, WorkspaceAccess>) -> Result<Option<String>, String> {
    access.recent()
}

fn git_snapshot_at(workspace: &Path) -> Result<GitSnapshot, String> {
    let status = run_git(
        workspace,
        &[
            "status",
            "--porcelain=v1",
            "--branch",
            "-z",
            "--untracked-files=all",
        ],
    )?;
    Ok(parse_git_snapshot(&status))
}

#[tauri::command]
fn git_snapshot(path: String, access: State<'_, WorkspaceAccess>) -> Result<GitSnapshot, String> {
    let workspace = access.resolve(&path)?;
    git_snapshot_at(&workspace)
}

fn git_branches_at(workspace: &Path) -> Result<Vec<String>, String> {
    let output = run_git(workspace, &["branch", "--format=%(refname:short)"])?;
    Ok(output.lines().map(str::to_owned).collect())
}

#[tauri::command]
fn git_branches(path: String, access: State<'_, WorkspaceAccess>) -> Result<Vec<String>, String> {
    let workspace = access.resolve(&path)?;
    git_branches_at(&workspace)
}

fn git_switch_branch_at(workspace: &Path, branch: &str) -> Result<GitSnapshot, String> {
    let branches = run_git(workspace, &["branch", "--format=%(refname:short)"])?;
    if !branches.lines().any(|candidate| candidate == branch) {
        return Err("The selected local branch does not exist".into());
    }

    run_git(workspace, &["switch", branch])?;
    git_snapshot_at(workspace)
}

#[tauri::command]
fn git_switch_branch(
    path: String,
    branch: String,
    access: State<'_, WorkspaceAccess>,
) -> Result<GitSnapshot, String> {
    let workspace = access.resolve(&path)?;
    git_switch_branch_at(&workspace, &branch)
}

fn git_diff_at(
    workspace: &Path,
    staged: bool,
    relative_path: Option<String>,
) -> Result<String, String> {
    let relative_path = relative_path
        .map(|path| safe_relative_path(&path).map(|relative| display_relative(&relative)))
        .transpose()?;
    let mut args = vec!["diff"];
    if staged {
        args.push("--cached");
    }
    args.push("--no-ext-diff");
    if let Some(relative_path) = relative_path.as_deref() {
        args.push("--");
        args.push(relative_path);
    }
    let diff = run_git_limited(workspace, &args, MAX_DIFF_OUTPUT_BYTES, "Git diff")?;
    if diff.lines().take(MAX_DIFF_OUTPUT_LINES + 1).count() > MAX_DIFF_OUTPUT_LINES {
        return Err(format!(
            "Git diff exceeds the {MAX_DIFF_OUTPUT_LINES} line preview limit"
        ));
    }
    Ok(diff)
}

#[tauri::command]
fn git_diff(
    path: String,
    staged: bool,
    relative_path: Option<String>,
    access: State<'_, WorkspaceAccess>,
) -> Result<String, String> {
    let workspace = access.resolve(&path)?;
    git_diff_at(&workspace, staged, relative_path)
}

fn workspace_tree_at(workspace: &Path) -> Result<WorkspaceTree, String> {
    let mut entries = Vec::new();
    let truncated = collect_workspace_tree(workspace, workspace, 0, &mut entries)?;
    Ok(WorkspaceTree { entries, truncated })
}

#[tauri::command]
fn workspace_tree(
    path: String,
    access: State<'_, WorkspaceAccess>,
) -> Result<WorkspaceTree, String> {
    let workspace = access.resolve(&path)?;
    workspace_tree_at(&workspace)
}

fn read_workspace_file_at(
    workspace: &Path,
    relative_path: String,
) -> Result<WorkspaceFile, String> {
    let relative = safe_relative_path(&relative_path)?;
    let file = workspace
        .join(&relative)
        .canonicalize()
        .map_err(|error| format!("Workspace file is unavailable: {error}"))?;
    if !file.starts_with(workspace) || !file.is_file() {
        return Err("Workspace file is outside the selected directory".into());
    }

    let size = fs::metadata(&file)
        .map_err(|error| format!("Workspace file metadata could not be read: {error}"))?
        .len();
    let mut bytes = Vec::with_capacity((size as usize).min(MAX_FILE_PREVIEW_BYTES));
    fs::File::open(&file)
        .map_err(|error| format!("Workspace file could not be opened: {error}"))?
        .take((MAX_FILE_PREVIEW_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Workspace file could not be read: {error}"))?;
    if bytes.iter().take(8192).any(|byte| *byte == 0) {
        return Err("Binary files cannot be previewed".into());
    }
    let mut truncated =
        size > MAX_FILE_PREVIEW_BYTES as u64 || bytes.len() > MAX_FILE_PREVIEW_BYTES;
    if truncated {
        bytes.truncate(MAX_FILE_PREVIEW_BYTES);
    }
    let decoded = String::from_utf8_lossy(&bytes);
    let mut lines = decoded.split_inclusive('\n');
    let content = lines
        .by_ref()
        .take(MAX_FILE_PREVIEW_LINES)
        .collect::<String>();
    truncated |= lines.next().is_some();

    Ok(WorkspaceFile {
        path: display_relative(&relative),
        content,
        size,
        truncated,
    })
}

#[tauri::command]
fn read_workspace_file(
    path: String,
    relative_path: String,
    access: State<'_, WorkspaceAccess>,
) -> Result<WorkspaceFile, String> {
    let workspace = access.resolve(&path)?;
    read_workspace_file_at(&workspace, relative_path)
}

#[tauri::command]
fn cc_switch_status() -> Result<CcSwitchStatus, String> {
    let installed = Path::new("/Applications/CC Switch.app").exists();
    let database = env::var_os("HOME")
        .map(PathBuf::from)
        .map(|home| home.join(".cc-switch/cc-switch.db"));

    let Some(database) = database.filter(|path| path.exists()) else {
        return Ok(CcSwitchStatus {
            installed,
            database_found: false,
            proxy_enabled: false,
            proxy_port: 15721,
            providers: Vec::new(),
        });
    };

    let connection = Connection::open_with_flags(
        database,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| format!("CC Switch database is unavailable: {error}"))?;

    let (proxy_enabled, proxy_port) = connection
        .query_row(
            "SELECT MAX(CASE WHEN enabled = 1 THEN 1 ELSE 0 END), COALESCE(MAX(listen_port), 15721) FROM proxy_config",
            [],
            |row| Ok((row.get::<_, i64>(0)? == 1, row.get::<_, u16>(1)?)),
        )
        .unwrap_or((false, 15721));

    let mut statement = connection
        .prepare(
            "SELECT p.id, p.name, p.app_type, p.is_current, p.in_failover_queue, MIN(e.url)
             FROM providers p
             LEFT JOIN provider_endpoints e ON e.provider_id = p.id AND e.app_type = p.app_type
             GROUP BY p.id, p.name, p.app_type, p.is_current, p.in_failover_queue
             ORDER BY p.is_current DESC, p.sort_index ASC, p.name ASC",
        )
        .map_err(|error| format!("CC Switch provider index is unavailable: {error}"))?;

    let providers = statement
        .query_map([], |row| {
            Ok(CcSwitchProvider {
                id: row.get(0)?,
                name: row.get(1)?,
                app_type: row.get(2)?,
                is_current: row.get::<_, i64>(3)? == 1,
                in_failover_queue: row.get::<_, i64>(4)? == 1,
                endpoint: row.get(5)?,
            })
        })
        .map_err(|error| format!("CC Switch providers could not be read: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("CC Switch providers could not be decoded: {error}"))?;

    Ok(CcSwitchStatus {
        installed,
        database_found: true,
        proxy_enabled,
        proxy_port,
        providers,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(WorkspaceAccess::default())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let store_path = app
                .path()
                .app_config_dir()
                .map_err(|error| format!("Application config directory is unavailable: {error}"))?
                .join("recent-workspace.json");
            app.state::<WorkspaceAccess>().load_recent(store_path)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            native_capabilities,
            pick_workspace,
            recent_workspace,
            git_snapshot,
            git_branches,
            git_switch_branch,
            git_diff,
            workspace_tree,
            read_workspace_file,
            cc_switch_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running Traceframe");
}

#[cfg(test)]
mod tests {
    use super::{
        git_diff_at, git_snapshot_at, git_switch_branch_at, parse_git_snapshot,
        read_workspace_file_at, safe_relative_path, workspace_tree_at, WorkspaceAccess,
        MAX_DIFF_OUTPUT_LINES, MAX_FILE_PREVIEW_BYTES, MAX_FILE_PREVIEW_LINES, MAX_TREE_ENTRIES,
    };
    use std::fs;
    use std::path::Path;
    use std::process::Command;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn run_test_git(path: &Path, args: &[&str]) {
        let status = Command::new("git")
            .arg("-C")
            .arg(path)
            .args(args)
            .status()
            .expect("git should start");
        assert!(status.success(), "git command failed: {args:?}");
    }

    #[test]
    fn parses_branch_divergence_and_renames() {
        let snapshot = parse_git_snapshot(
            "## feature/auth...origin/feature/auth [ahead 2, behind 1]\nR  old.ts -> src/new.ts\n M src/lib.ts\n?? notes.md\n",
        );

        assert_eq!(snapshot.branch, "feature/auth");
        assert_eq!(snapshot.ahead, 2);
        assert_eq!(snapshot.behind, 1);
        assert_eq!(snapshot.files.len(), 3);
        assert_eq!(snapshot.files[0].path, "src/new.ts");
        assert_eq!(snapshot.files[2].worktree_status, "?");

        let nul_snapshot =
            parse_git_snapshot("## main\0R  src/新名称.ts\0src/旧名称.ts\0?? src/中文.ts\0");
        assert_eq!(nul_snapshot.files.len(), 2);
        assert_eq!(nul_snapshot.files[0].path, "src/新名称.ts");
        assert_eq!(nul_snapshot.files[1].path, "src/中文.ts");
    }

    #[test]
    fn rejects_paths_outside_workspace() {
        assert!(safe_relative_path("src/main.rs").is_ok());
        assert!(safe_relative_path("../secrets.txt").is_err());
        assert!(safe_relative_path("/tmp/secrets.txt").is_err());
        assert!(safe_relative_path("").is_err());
    }

    #[test]
    fn reads_real_workspace_and_switches_branch() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be valid")
            .as_nanos();
        let workspace = std::env::temp_dir().join(format!(
            "traceframe-workspace-test-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(workspace.join("src")).expect("workspace should be created");
        fs::write(workspace.join("src/main.ts"), "export const value = 1\n")
            .expect("fixture should be written");

        run_test_git(&workspace, &["init", "-b", "main"]);
        run_test_git(&workspace, &["config", "user.name", "Traceframe Test"]);
        run_test_git(
            &workspace,
            &["config", "user.email", "traceframe-test@example.invalid"],
        );
        run_test_git(&workspace, &["add", "."]);
        run_test_git(&workspace, &["commit", "-m", "fixture"]);
        run_test_git(&workspace, &["branch", "review"]);

        let access = WorkspaceAccess::default();
        let canonical = workspace
            .canonicalize()
            .expect("workspace should canonicalize");
        assert!(access.resolve(&workspace.to_string_lossy()).is_err());
        access
            .register(canonical.clone())
            .expect("workspace should be authorized");
        assert_eq!(
            access
                .resolve(&workspace.to_string_lossy())
                .expect("authorized workspace should resolve"),
            canonical
        );

        let switched =
            git_switch_branch_at(&canonical, "review").expect("local branch should switch");
        assert_eq!(switched.branch, "review");
        fs::write(workspace.join("src/main.ts"), "export const value = 9\n")
            .expect("review fixture should be updated");
        run_test_git(&workspace, &["add", "."]);
        run_test_git(&workspace, &["commit", "-m", "review fixture"]);
        git_switch_branch_at(&canonical, "main").expect("main should be restored");

        fs::write(workspace.join("src/main.ts"), "export const value = 2\n")
            .expect("fixture should be updated");
        fs::write(
            workspace.join("src/中文.ts"),
            "export const locale = 'zh'\n",
        )
        .expect("unicode fixture should be written");
        assert!(git_switch_branch_at(&canonical, "review").is_err());

        let snapshot = git_snapshot_at(&canonical).expect("snapshot should load");
        assert_eq!(snapshot.branch, "main");
        assert!(snapshot.files.iter().any(|file| file.path == "src/main.ts"));
        assert!(snapshot.files.iter().any(|file| file.path == "src/中文.ts"));

        let tree = workspace_tree_at(&canonical).expect("tree should load");
        assert!(tree.entries.iter().any(|entry| entry.path == "src/main.ts"));
        assert!(!tree
            .entries
            .iter()
            .any(|entry| entry.path.starts_with(".git")));

        let file = read_workspace_file_at(&canonical, "src/main.ts".into())
            .expect("text file should load");
        assert!(file.content.contains("value = 2"));
        let diff = git_diff_at(&canonical, false, Some("src/main.ts".into()))
            .expect("working tree diff should load");
        assert!(diff.contains("value = 2"));

        fs::write(
            workspace.join("large.txt"),
            vec![b'x'; MAX_FILE_PREVIEW_BYTES + 128],
        )
        .expect("large fixture should be written");
        let large = read_workspace_file_at(&canonical, "large.txt".into())
            .expect("large text preview should load");
        assert!(large.truncated);
        assert_eq!(large.content.len(), MAX_FILE_PREVIEW_BYTES);

        fs::write(
            workspace.join("many-lines.txt"),
            "line\n".repeat(MAX_FILE_PREVIEW_LINES + 5),
        )
        .expect("line fixture should be written");
        let many_lines = read_workspace_file_at(&canonical, "many-lines.txt".into())
            .expect("line-limited preview should load");
        assert!(many_lines.truncated);
        assert_eq!(many_lines.content.lines().count(), MAX_FILE_PREVIEW_LINES);

        fs::write(
            workspace.join("diff-lines.txt"),
            "added\n".repeat(MAX_DIFF_OUTPUT_LINES + 5),
        )
        .expect("large diff fixture should be written");
        run_test_git(&workspace, &["add", "diff-lines.txt"]);
        let diff_error = git_diff_at(&canonical, true, Some("diff-lines.txt".into()))
            .expect_err("oversized diff should be rejected");
        assert!(diff_error.contains("line preview limit"));

        fs::write(workspace.join("binary.bin"), [0, 1, 2])
            .expect("binary fixture should be written");
        assert!(read_workspace_file_at(&canonical, "binary.bin".into()).is_err());

        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let outside = workspace.with_extension("outside.txt");
            fs::write(&outside, "outside\n").expect("outside fixture should be written");
            symlink(&outside, workspace.join("outside-link.txt"))
                .expect("symlink fixture should be created");
            assert!(read_workspace_file_at(&canonical, "outside-link.txt".into()).is_err());
            fs::remove_file(outside).expect("outside fixture should be removed");
        }

        fs::create_dir_all(workspace.join("bulk")).expect("bulk directory should be created");
        for index in 0..MAX_TREE_ENTRIES + 5 {
            fs::write(workspace.join(format!("bulk/{index:04}.txt")), "x\n")
                .expect("bulk fixture should be written");
        }
        let limited_tree = workspace_tree_at(&canonical).expect("limited tree should load");
        assert!(limited_tree.truncated);
        assert!(limited_tree.entries.len() <= MAX_TREE_ENTRIES);

        fs::remove_dir_all(&workspace).expect("temporary workspace should be removed");
    }
}
