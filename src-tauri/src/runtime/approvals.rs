use super::RuntimeControl;
use crate::safe_relative_path;
use crate::store::AppStore;
use crate::WorkspaceAccess;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::State;

const MAX_APPROVAL_FILE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_APPROVAL_SNAPSHOT_BYTES: u64 = 128 * 1024 * 1024;
static RESTORE_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PermissionMode {
    #[default]
    RequestApproval,
    FullAccess,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ApprovalDecision {
    Accept,
    Reject,
}

impl ApprovalDecision {
    pub fn file_status(self) -> ApprovalFileStatus {
        match self {
            Self::Accept => ApprovalFileStatus::Accepted,
            Self::Reject => ApprovalFileStatus::Rejected,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Accept => "accept",
            Self::Reject => "reject",
        }
    }

    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "accept" => Ok(Self::Accept),
            "reject" => Ok(Self::Reject),
            _ => Err(format!("Unknown approval decision '{value}'")),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ApprovalBatchStatus {
    Pending,
    Accepted,
    Rejected,
    PartiallyAccepted,
}

impl ApprovalBatchStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Accepted => "accepted",
            Self::Rejected => "rejected",
            Self::PartiallyAccepted => "partially-accepted",
        }
    }

    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "pending" => Ok(Self::Pending),
            "accepted" => Ok(Self::Accepted),
            "rejected" => Ok(Self::Rejected),
            "partially-accepted" => Ok(Self::PartiallyAccepted),
            _ => Err(format!("Unknown approval batch status '{value}'")),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ApprovalFileStatus {
    Pending,
    Accepted,
    Rejected,
}

impl ApprovalFileStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Accepted => "accepted",
            Self::Rejected => "rejected",
        }
    }

    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "pending" => Ok(Self::Pending),
            "accepted" => Ok(Self::Accepted),
            "rejected" => Ok(Self::Rejected),
            _ => Err(format!("Unknown approval file status '{value}'")),
        }
    }
}

impl PermissionMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::RequestApproval => "request-approval",
            Self::FullAccess => "full-access",
        }
    }

    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "request-approval" => Ok(Self::RequestApproval),
            "full-access" => Ok(Self::FullAccess),
            _ => Err(format!("Unknown permission mode '{value}'")),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileVersion {
    pub exists: bool,
    pub content: Vec<u8>,
    pub unix_mode: Option<u32>,
}

impl FileVersion {
    fn missing() -> Self {
        Self {
            exists: false,
            content: Vec::new(),
            unix_mode: None,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalFileRecord {
    pub id: String,
    pub batch_id: String,
    pub path: String,
    pub status: ApprovalFileStatus,
    pub diff: String,
    pub start_line: usize,
    pub end_line: usize,
    #[serde(skip)]
    pub before: FileVersion,
    #[serde(skip)]
    pub after: FileVersion,
    pub decided_at: Option<u64>,
    pub decision_reason: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalBatchRecord {
    pub id: String,
    pub session_id: String,
    pub run_id: String,
    pub workspace_path: String,
    pub permission_mode: PermissionMode,
    pub status: ApprovalBatchStatus,
    pub files: Vec<ApprovalFileRecord>,
    pub decisions: Vec<ApprovalAuditRecord>,
    pub created_at: u64,
    pub resolved_at: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalAuditRecord {
    pub id: String,
    pub batch_id: String,
    pub file_id: String,
    pub path: String,
    pub decision: ApprovalDecision,
    pub reason: String,
    pub actor: String,
    pub created_at: u64,
}

#[derive(Debug)]
pub struct PreparedApprovalFile {
    pub path: String,
    pub diff: String,
    pub start_line: usize,
    pub end_line: usize,
    pub before: FileVersion,
    pub after: FileVersion,
}

#[derive(Debug)]
pub struct WorkspaceChangeJournal {
    workspace: PathBuf,
    originals: BTreeMap<String, FileVersion>,
    repository_inventory: BTreeSet<String>,
    captured_bytes: u64,
    repository_captured: bool,
}

impl WorkspaceChangeJournal {
    pub fn new(workspace: &Path) -> Result<Self, String> {
        let workspace = workspace
            .canonicalize()
            .map_err(|error| format!("Approval workspace is unavailable: {error}"))?;
        if !workspace.is_dir() {
            return Err("Approval workspace is not a directory".into());
        }
        Ok(Self {
            workspace,
            originals: BTreeMap::new(),
            repository_inventory: BTreeSet::new(),
            captured_bytes: 0,
            repository_captured: false,
        })
    }

    pub fn capture_path(&mut self, path: &str) -> Result<(), String> {
        let relative = normalize_path(path)?;
        if self.originals.contains_key(&relative) {
            return Ok(());
        }
        let version = read_version(&self.workspace, &relative)?;
        self.reserve(&relative, version.content.len() as u64)?;
        self.originals.insert(relative, version);
        Ok(())
    }

    pub fn capture_repository(&mut self) -> Result<(), String> {
        if self.repository_captured {
            return Ok(());
        }
        let paths = repository_paths(&self.workspace)?;
        for path in paths {
            self.capture_path(&path)?;
            self.repository_inventory.insert(path);
        }
        self.repository_captured = true;
        Ok(())
    }

    pub fn capture_tool_call(&mut self, name: &str, raw_arguments: &str) -> Result<(), String> {
        let arguments: Value = serde_json::from_str(raw_arguments)
            .map_err(|error| format!("Approval tool arguments are invalid JSON: {error}"))?;
        match name {
            "edit_file" | "write_file" | "create_file" => {
                let path = arguments
                    .get("path")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "Approval tool path must be a string".to_string())?;
                self.capture_path(path)
            }
            "run_command" => self.capture_repository(),
            _ => Ok(()),
        }
    }

    pub fn register_changed_path(&mut self, path: &str) -> Result<(), String> {
        let relative = normalize_path(path)?;
        if self.originals.contains_key(&relative) {
            return Ok(());
        }
        if self.repository_captured && !self.repository_inventory.contains(&relative) {
            self.originals.insert(relative, FileVersion::missing());
            return Ok(());
        }
        Err(format!(
            "Approval safety snapshot is missing for '{relative}'; the change cannot be made reversible"
        ))
    }

    pub fn prepare(self) -> Result<Vec<PreparedApprovalFile>, String> {
        let mut changes = Vec::new();
        for (path, before) in self.originals {
            let after = read_version(&self.workspace, &path)?;
            if before == after {
                continue;
            }
            let diff = unified_diff(&path, &before, &after);
            let (start_line, end_line) = changed_line_range(&before, &after);
            changes.push(PreparedApprovalFile {
                path,
                diff,
                start_line,
                end_line,
                before,
                after,
            });
        }
        Ok(changes)
    }

    fn reserve(&mut self, path: &str, bytes: u64) -> Result<(), String> {
        if bytes > MAX_APPROVAL_FILE_BYTES {
            return Err(format!(
                "'{path}' is larger than the {} MiB reversible-change limit",
                MAX_APPROVAL_FILE_BYTES / 1024 / 1024
            ));
        }
        let next = self.captured_bytes.saturating_add(bytes);
        if next > MAX_APPROVAL_SNAPSHOT_BYTES {
            return Err(format!(
                "The approval snapshot exceeds the {} MiB run limit",
                MAX_APPROVAL_SNAPSHOT_BYTES / 1024 / 1024
            ));
        }
        self.captured_bytes = next;
        Ok(())
    }
}

pub fn preflight_decision(workspace: &Path, files: &[ApprovalFileRecord]) -> Result<(), String> {
    for file in files {
        if file.status != ApprovalFileStatus::Pending {
            return Err(format!("'{}' has already been decided", file.path));
        }
        let current = read_version(workspace, &file.path)?;
        if current != file.after {
            return Err(format!(
                "'{}' changed after the AI edit; reload the diff before deciding",
                file.path
            ));
        }
    }
    Ok(())
}

pub fn apply_decision(
    workspace: &Path,
    files: &[ApprovalFileRecord],
    decision: ApprovalDecision,
) -> Result<(), String> {
    preflight_decision(workspace, files)?;
    if decision == ApprovalDecision::Accept {
        return Ok(());
    }
    let mut restored = Vec::new();
    for file in files {
        if let Err(error) = restore_version(workspace, &file.path, &file.before) {
            let compensation_errors = restored
                .into_iter()
                .rev()
                .filter_map(|restored_file: &ApprovalFileRecord| {
                    restore_version(workspace, &restored_file.path, &restored_file.after)
                        .err()
                        .map(|reason| format!("{}: {reason}", restored_file.path))
                })
                .collect::<Vec<_>>();
            if compensation_errors.is_empty() {
                return Err(format!(
                    "Approval rejection was not applied because '{}' could not be restored: {error}",
                    file.path
                ));
            }
            return Err(format!(
                "Approval rejection failed at '{}': {error}. Restoring the already processed files also failed: {}",
                file.path,
                compensation_errors.join("; ")
            ));
        }
        restored.push(file);
    }
    Ok(())
}

pub fn aggregate_status(files: &[ApprovalFileRecord]) -> ApprovalBatchStatus {
    if files
        .iter()
        .any(|file| file.status == ApprovalFileStatus::Pending)
    {
        return ApprovalBatchStatus::Pending;
    }
    let accepted = files
        .iter()
        .any(|file| file.status == ApprovalFileStatus::Accepted);
    let rejected = files
        .iter()
        .any(|file| file.status == ApprovalFileStatus::Rejected);
    match (accepted, rejected) {
        (true, true) => ApprovalBatchStatus::PartiallyAccepted,
        (true, false) => ApprovalBatchStatus::Accepted,
        (false, true) => ApprovalBatchStatus::Rejected,
        (false, false) => ApprovalBatchStatus::Accepted,
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalDecisionRequest {
    pub batch_id: String,
    #[serde(default)]
    pub paths: Option<Vec<String>>,
    pub decision: ApprovalDecision,
    #[serde(default)]
    pub reason: String,
}

#[tauri::command]
pub fn approval_batches(
    session_id: String,
    store: State<'_, AppStore>,
) -> Result<Vec<ApprovalBatchRecord>, String> {
    store.session_approval_batches(&session_id)
}

#[tauri::command]
pub fn approval_decide(
    request: ApprovalDecisionRequest,
    control: State<'_, RuntimeControl>,
    store: State<'_, AppStore>,
    access: State<'_, WorkspaceAccess>,
) -> Result<ApprovalBatchRecord, String> {
    let batch = store.approval_batch_record(&request.batch_id)?;
    if batch.status != ApprovalBatchStatus::Pending {
        return Err("Approval batch is no longer pending".into());
    }
    let selected_paths = request
        .paths
        .as_ref()
        .map(|paths| {
            paths
                .iter()
                .map(|path| normalize_path(path))
                .collect::<Result<BTreeSet<_>, _>>()
        })
        .transpose()?;
    let files = batch
        .files
        .iter()
        .filter(|file| {
            file.status == ApprovalFileStatus::Pending
                && selected_paths
                    .as_ref()
                    .is_none_or(|paths| paths.contains(&file.path))
        })
        .cloned()
        .collect::<Vec<_>>();
    if files.is_empty() {
        return Err("No pending approval files matched the decision".into());
    }
    let workspace = access.resolve(&batch.workspace_path)?;
    apply_decision(&workspace, &files, request.decision)?;
    let paths = files
        .iter()
        .map(|file| file.path.clone())
        .collect::<Vec<_>>();
    let updated = store.record_approval_decision(
        &batch.id,
        Some(&paths),
        request.decision,
        &request.reason,
        "user",
    )?;
    control.notify_approval(&batch.run_id)?;
    Ok(updated)
}

fn normalize_path(path: &str) -> Result<String, String> {
    let relative = safe_relative_path(path)?;
    Ok(relative.to_string_lossy().replace('\\', "/"))
}

fn repository_paths(workspace: &Path) -> Result<Vec<String>, String> {
    let output = Command::new("git")
        .args([
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
        ])
        .current_dir(workspace)
        .output()
        .map_err(|error| format!("Approval repository inventory could not start: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "Approval repository inventory failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    output
        .stdout
        .split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
        .map(|path| {
            std::str::from_utf8(path)
                .map_err(|_| "A repository path is not valid UTF-8".to_string())
                .and_then(normalize_path)
        })
        .collect()
}

fn read_version(workspace: &Path, path: &str) -> Result<FileVersion, String> {
    let relative = safe_relative_path(path)?;
    let target = workspace.join(&relative);
    let metadata = match fs::symlink_metadata(&target) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(FileVersion::missing())
        }
        Err(error) => return Err(format!("Approval file metadata could not be read: {error}")),
    };
    if metadata.file_type().is_symlink() {
        return Err(format!("Approval cannot follow symbolic link '{path}'"));
    }
    if !metadata.is_file() {
        return Err(format!("Approval path '{path}' is not a file"));
    }
    if metadata.len() > MAX_APPROVAL_FILE_BYTES {
        return Err(format!(
            "'{path}' is larger than the {} MiB reversible-change limit",
            MAX_APPROVAL_FILE_BYTES / 1024 / 1024
        ));
    }
    let content =
        fs::read(&target).map_err(|error| format!("Approval file could not be read: {error}"))?;
    #[cfg(unix)]
    let unix_mode = {
        use std::os::unix::fs::PermissionsExt;
        Some(metadata.permissions().mode())
    };
    #[cfg(not(unix))]
    let unix_mode = None;
    Ok(FileVersion {
        exists: true,
        content,
        unix_mode,
    })
}

fn restore_version(workspace: &Path, path: &str, version: &FileVersion) -> Result<(), String> {
    let relative = safe_relative_path(path)?;
    let target = workspace.join(&relative);
    let parent = target
        .parent()
        .ok_or_else(|| "Rejected file has no parent directory".to_string())?;
    let canonical_workspace = workspace
        .canonicalize()
        .map_err(|error| format!("Approval workspace is unavailable: {error}"))?;
    if !version.exists {
        let canonical_parent = parent
            .canonicalize()
            .map_err(|error| format!("Rejected file parent is unavailable: {error}"))?;
        if !canonical_parent.starts_with(&canonical_workspace) {
            return Err("Rejected file parent escaped the workspace".into());
        }
        match fs::remove_file(&target) {
            Ok(()) => return Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(format!("Rejected file could not be removed: {error}")),
        }
    }
    fs::create_dir_all(parent)
        .map_err(|error| format!("Rejected file parent could not be restored: {error}"))?;
    let canonical_parent = parent
        .canonicalize()
        .map_err(|error| format!("Rejected file parent is unavailable: {error}"))?;
    if !canonical_parent.starts_with(&canonical_workspace) {
        return Err("Rejected file parent escaped the workspace".into());
    }
    let file_name = target
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Rejected file name is not valid UTF-8".to_string())?;
    let nonce = RESTORE_COUNTER.fetch_add(1, Ordering::Relaxed);
    let temporary = parent.join(format!(
        ".{file_name}.traceframe-approval-{}-{nonce}.tmp",
        std::process::id()
    ));
    let result = (|| -> Result<(), String> {
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| {
                format!("Rejected file temporary copy could not be created: {error}")
            })?;
        output
            .write_all(&version.content)
            .map_err(|error| format!("Rejected file could not be restored: {error}"))?;
        output
            .sync_all()
            .map_err(|error| format!("Rejected file could not be synchronized: {error}"))?;
        #[cfg(unix)]
        if let Some(mode) = version.unix_mode {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&temporary, fs::Permissions::from_mode(mode)).map_err(|error| {
                format!("Rejected file permissions could not be restored: {error}")
            })?;
        }
        fs::rename(&temporary, &target)
            .map_err(|error| format!("Rejected file could not replace the AI version: {error}"))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn changed_line_range(before: &FileVersion, after: &FileVersion) -> (usize, usize) {
    let before = std::str::from_utf8(&before.content).unwrap_or("");
    let after = std::str::from_utf8(&after.content).unwrap_or("");
    let before_lines = before.split('\n').collect::<Vec<_>>();
    let after_lines = after.split('\n').collect::<Vec<_>>();
    let mut prefix = 0;
    while prefix < before_lines.len()
        && prefix < after_lines.len()
        && before_lines[prefix] == after_lines[prefix]
    {
        prefix += 1;
    }
    let mut suffix = 0;
    while suffix < before_lines.len().saturating_sub(prefix)
        && suffix < after_lines.len().saturating_sub(prefix)
        && before_lines[before_lines.len() - 1 - suffix]
            == after_lines[after_lines.len() - 1 - suffix]
    {
        suffix += 1;
    }
    let start = (prefix + 1).min(after_lines.len().max(1));
    let changed = after_lines.len().saturating_sub(prefix + suffix);
    let end = if changed == 0 {
        start
    } else {
        (prefix + changed).min(after_lines.len().max(1))
    };
    (start, end.max(start))
}

fn unified_diff(path: &str, before: &FileVersion, after: &FileVersion) -> String {
    let (Ok(before_text), Ok(after_text)) = (
        std::str::from_utf8(&before.content),
        std::str::from_utf8(&after.content),
    ) else {
        return format!(
            "--- {}\n+++ {}\nBinary file changed ({} -> {} bytes)\n",
            if before.exists {
                format!("a/{path}")
            } else {
                "/dev/null".into()
            },
            if after.exists {
                format!("b/{path}")
            } else {
                "/dev/null".into()
            },
            before.content.len(),
            after.content.len()
        );
    };
    let before_lines = before_text.split('\n').collect::<Vec<_>>();
    let after_lines = after_text.split('\n').collect::<Vec<_>>();
    let mut prefix = 0;
    while prefix < before_lines.len()
        && prefix < after_lines.len()
        && before_lines[prefix] == after_lines[prefix]
    {
        prefix += 1;
    }
    let mut suffix = 0;
    while suffix < before_lines.len().saturating_sub(prefix)
        && suffix < after_lines.len().saturating_sub(prefix)
        && before_lines[before_lines.len() - 1 - suffix]
            == after_lines[after_lines.len() - 1 - suffix]
    {
        suffix += 1;
    }
    let context_start = prefix.saturating_sub(3);
    let before_end = before_lines.len().saturating_sub(suffix);
    let after_end = after_lines.len().saturating_sub(suffix);
    let context_suffix = suffix.min(3);
    let old_count = before_end
        .saturating_sub(context_start)
        .saturating_add(context_suffix);
    let new_count = after_end
        .saturating_sub(context_start)
        .saturating_add(context_suffix);
    let mut diff = format!(
        "--- {}\n+++ {}\n@@ -{},{} +{},{} @@\n",
        if before.exists {
            format!("a/{path}")
        } else {
            "/dev/null".into()
        },
        if after.exists {
            format!("b/{path}")
        } else {
            "/dev/null".into()
        },
        context_start + 1,
        old_count,
        context_start + 1,
        new_count,
    );
    for line in &before_lines[context_start..prefix] {
        diff.push(' ');
        diff.push_str(line);
        diff.push('\n');
    }
    for line in &before_lines[prefix..before_end] {
        diff.push('-');
        diff.push_str(line);
        diff.push('\n');
    }
    for line in &after_lines[prefix..after_end] {
        diff.push('+');
        diff.push_str(line);
        diff.push('\n');
    }
    let suffix_start = before_lines.len().saturating_sub(context_suffix);
    for line in &before_lines[suffix_start..] {
        diff.push(' ');
        diff.push_str(line);
        diff.push('\n');
    }
    diff
}

#[cfg(test)]
mod tests {
    use super::{
        aggregate_status, apply_decision, ApprovalBatchStatus, ApprovalDecision,
        ApprovalFileRecord, ApprovalFileStatus, PermissionMode, WorkspaceChangeJournal,
    };
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static FIXTURE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    fn fixture() -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let sequence = FIXTURE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "traceframe-approvals-{}-{nonce}-{sequence}",
            std::process::id()
        ));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn defaults_to_request_approval() {
        assert_eq!(PermissionMode::default(), PermissionMode::RequestApproval);
    }

    #[test]
    fn journal_keeps_the_first_before_version_and_builds_an_exact_diff() {
        let root = fixture();
        std::fs::write(root.join("main.rs"), "fn main() {\n    old();\n}\n").unwrap();
        let mut journal = WorkspaceChangeJournal::new(&root).unwrap();
        journal.capture_path("main.rs").unwrap();
        std::fs::write(root.join("main.rs"), "fn main() {\n    middle();\n}\n").unwrap();
        journal.capture_path("main.rs").unwrap();
        std::fs::write(root.join("main.rs"), "fn main() {\n    new();\n}\n").unwrap();
        let changes = journal.prepare().unwrap();
        assert_eq!(changes.len(), 1);
        assert!(changes[0].diff.contains("-    old();"));
        assert!(changes[0].diff.contains("+    new();"));
        assert_eq!((changes[0].start_line, changes[0].end_line), (2, 2));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn rejecting_restores_modified_and_created_files() {
        let root = fixture();
        std::fs::write(root.join("existing.txt"), "before\n").unwrap();
        let mut journal = WorkspaceChangeJournal::new(&root).unwrap();
        journal.capture_path("existing.txt").unwrap();
        journal.capture_path("created.txt").unwrap();
        std::fs::write(root.join("existing.txt"), "after\n").unwrap();
        std::fs::write(root.join("created.txt"), "created\n").unwrap();
        let prepared = journal.prepare().unwrap();
        let files = prepared
            .into_iter()
            .enumerate()
            .map(|(index, file)| ApprovalFileRecord {
                id: format!("file-{index}"),
                batch_id: "batch".into(),
                path: file.path,
                status: ApprovalFileStatus::Pending,
                diff: file.diff,
                start_line: file.start_line,
                end_line: file.end_line,
                before: file.before,
                after: file.after,
                decided_at: None,
                decision_reason: String::new(),
            })
            .collect::<Vec<_>>();
        apply_decision(&root, &files, ApprovalDecision::Reject).unwrap();
        assert_eq!(
            std::fs::read_to_string(root.join("existing.txt")).unwrap(),
            "before\n"
        );
        assert!(!root.join("created.txt").exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn reject_refuses_to_overwrite_a_newer_user_edit() {
        let root = fixture();
        std::fs::write(root.join("main.ts"), "before\n").unwrap();
        let mut journal = WorkspaceChangeJournal::new(&root).unwrap();
        journal.capture_path("main.ts").unwrap();
        std::fs::write(root.join("main.ts"), "ai\n").unwrap();
        let file = journal.prepare().unwrap().remove(0);
        std::fs::write(root.join("main.ts"), "user\n").unwrap();
        let record = ApprovalFileRecord {
            id: "file".into(),
            batch_id: "batch".into(),
            path: file.path,
            status: ApprovalFileStatus::Pending,
            diff: file.diff,
            start_line: file.start_line,
            end_line: file.end_line,
            before: file.before,
            after: file.after,
            decided_at: None,
            decision_reason: String::new(),
        };
        let error = apply_decision(&root, &[record], ApprovalDecision::Reject).unwrap_err();
        assert!(error.contains("changed after the AI edit"));
        assert_eq!(
            std::fs::read_to_string(root.join("main.ts")).unwrap(),
            "user\n"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn reject_refuses_to_remove_a_created_file_through_a_parent_symlink() {
        use std::os::unix::fs::symlink;

        let root = fixture();
        let outside = fixture();
        let mut journal = WorkspaceChangeJournal::new(&root).unwrap();
        journal.capture_path("generated/output.txt").unwrap();
        std::fs::create_dir(root.join("generated")).unwrap();
        std::fs::write(root.join("generated/output.txt"), "ai\n").unwrap();
        let file = journal.prepare().unwrap().remove(0);
        std::fs::remove_dir_all(root.join("generated")).unwrap();
        std::fs::write(outside.join("output.txt"), "ai\n").unwrap();
        symlink(&outside, root.join("generated")).unwrap();
        let record = ApprovalFileRecord {
            id: "file".into(),
            batch_id: "batch".into(),
            path: file.path,
            status: ApprovalFileStatus::Pending,
            diff: file.diff,
            start_line: file.start_line,
            end_line: file.end_line,
            before: file.before,
            after: file.after,
            decided_at: None,
            decision_reason: String::new(),
        };

        let error = apply_decision(&root, &[record], ApprovalDecision::Reject).unwrap_err();
        assert!(error.contains("parent escaped the workspace"));
        assert_eq!(
            std::fs::read_to_string(outside.join("output.txt")).unwrap(),
            "ai\n"
        );
        let _ = std::fs::remove_file(root.join("generated"));
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(outside);
    }

    #[cfg(unix)]
    #[test]
    fn failed_batch_rejection_compensates_files_already_restored() {
        use std::os::unix::fs::symlink;

        let root = fixture();
        let outside = fixture();
        std::fs::write(root.join("a.txt"), "ai-a\n").unwrap();
        std::fs::write(outside.join("b.txt"), "ai-b\n").unwrap();
        symlink(&outside, root.join("z-outside")).unwrap();
        let record = |id: &str, path: &str, before: &str| {
            let after = super::read_version(&root, path).unwrap();
            let mut before_version = after.clone();
            before_version.content = before.as_bytes().to_vec();
            ApprovalFileRecord {
                id: id.into(),
                batch_id: "batch".into(),
                path: path.into(),
                status: ApprovalFileStatus::Pending,
                diff: String::new(),
                start_line: 1,
                end_line: 1,
                before: before_version,
                after,
                decided_at: None,
                decision_reason: String::new(),
            }
        };
        let files = vec![
            record("first", "a.txt", "before-a\n"),
            record("second", "z-outside/b.txt", "before-b\n"),
        ];

        let error = apply_decision(&root, &files, ApprovalDecision::Reject).unwrap_err();
        assert!(error.contains("could not be restored"));
        assert_eq!(
            std::fs::read_to_string(root.join("a.txt")).unwrap(),
            "ai-a\n"
        );
        assert_eq!(
            std::fs::read_to_string(outside.join("b.txt")).unwrap(),
            "ai-b\n"
        );
        let _ = std::fs::remove_file(root.join("z-outside"));
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(outside);
    }

    #[test]
    fn aggregate_status_distinguishes_partial_decisions() {
        let make = |status| ApprovalFileRecord {
            id: String::new(),
            batch_id: String::new(),
            path: String::new(),
            status,
            diff: String::new(),
            start_line: 1,
            end_line: 1,
            before: super::FileVersion::missing(),
            after: super::FileVersion::missing(),
            decided_at: None,
            decision_reason: String::new(),
        };
        assert_eq!(
            aggregate_status(&[
                make(ApprovalFileStatus::Accepted),
                make(ApprovalFileStatus::Rejected),
            ]),
            ApprovalBatchStatus::PartiallyAccepted
        );
        assert_eq!(
            aggregate_status(&[
                make(ApprovalFileStatus::Accepted),
                make(ApprovalFileStatus::Pending),
            ]),
            ApprovalBatchStatus::Pending
        );
    }
}
