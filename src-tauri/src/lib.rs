use serde::Serialize;
use rusqlite::{Connection, OpenFlags};
use std::env;
use std::path::{Path, PathBuf};
use std::process::Command;

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

fn run_git(path: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(args)
        .output()
        .map_err(|error| format!("Git could not be started: {error}"))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_owned());
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
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
fn git_snapshot(path: String) -> Result<GitSnapshot, String> {
    let workspace = canonical_workspace(&path)?;
    let status = run_git(&workspace, &["status", "--porcelain=v1", "--branch"])?;
    let mut lines = status.lines();
    let branch_line = lines.next().unwrap_or("## HEAD");
    let branch = branch_line
        .trim_start_matches("## ")
        .split(['.', ' '])
        .next()
        .unwrap_or("HEAD")
        .to_owned();
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
    let files = lines
        .filter(|line| line.len() >= 3)
        .map(|line| GitFileState {
            index_status: line[0..1].to_owned(),
            worktree_status: line[1..2].to_owned(),
            path: line[3..].to_owned(),
        })
        .collect();

    Ok(GitSnapshot { branch, ahead, behind, files })
}

#[tauri::command]
fn git_branches(path: String) -> Result<Vec<String>, String> {
    let workspace = canonical_workspace(&path)?;
    let output = run_git(&workspace, &["branch", "--format=%(refname:short)"])?;
    Ok(output.lines().map(str::to_owned).collect())
}

#[tauri::command]
fn git_diff(path: String, staged: bool) -> Result<String, String> {
    let workspace = canonical_workspace(&path)?;
    if staged {
        run_git(&workspace, &["diff", "--cached", "--no-ext-diff"])
    } else {
        run_git(&workspace, &["diff", "--no-ext-diff"])
    }
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
        .invoke_handler(tauri::generate_handler![
            native_capabilities,
            git_snapshot,
            git_branches,
            git_diff,
            cc_switch_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running Traceframe");
}
