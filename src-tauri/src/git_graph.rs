use crate::{run_git, run_git_limited, WorkspaceAccess};
use serde::Serialize;
use std::path::Path;
use tauri::State;

const DEFAULT_GRAPH_LIMIT: usize = 200;
const MAX_GRAPH_LIMIT: usize = 500;
const MAX_GRAPH_OUTPUT_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitGraphCommit {
    hash: String,
    short_hash: String,
    parents: Vec<String>,
    author: String,
    authored_at: String,
    subject: String,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitGraphRef {
    name: String,
    full_name: String,
    hash: String,
    kind: String,
    is_current: bool,
    symbolic_target: Option<String>,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitGraphSnapshot {
    head: Option<String>,
    current_branch: Option<String>,
    commits: Vec<GitGraphCommit>,
    refs: Vec<GitGraphRef>,
    truncated: bool,
}

fn parse_commits(output: &str) -> Vec<GitGraphCommit> {
    output
        .split('\x1e')
        .filter_map(|record| {
            let fields = record
                .trim_matches(['\r', '\n'])
                .split('\x1f')
                .collect::<Vec<_>>();
            if fields.len() != 6 || fields[0].is_empty() {
                return None;
            }
            Some(GitGraphCommit {
                hash: fields[0].to_owned(),
                short_hash: fields[1].to_owned(),
                parents: fields[2]
                    .split_ascii_whitespace()
                    .map(str::to_owned)
                    .collect(),
                author: fields[3].to_owned(),
                authored_at: fields[4].to_owned(),
                subject: fields[5].to_owned(),
            })
        })
        .collect()
}

fn ref_kind(full_name: &str) -> &'static str {
    if full_name.starts_with("refs/heads/") {
        "local"
    } else if full_name.starts_with("refs/remotes/") {
        "remote"
    } else {
        "tag"
    }
}

fn short_ref_name(full_name: &str) -> String {
    ["refs/heads/", "refs/remotes/", "refs/tags/"]
        .iter()
        .find_map(|prefix| full_name.strip_prefix(prefix))
        .unwrap_or(full_name)
        .to_owned()
}

fn parse_refs(output: &str, current_branch: Option<&str>) -> Vec<GitGraphRef> {
    output
        .split('\x1e')
        .filter_map(|record| {
            let fields = record
                .trim_matches(['\r', '\n'])
                .split('\x1f')
                .collect::<Vec<_>>();
            if fields.len() != 5 || fields[0].is_empty() || fields[1].is_empty() {
                return None;
            }
            let full_name = fields[0].to_owned();
            let hash = if fields[4].is_empty() {
                fields[1]
            } else {
                fields[4]
            };
            let is_current = full_name
                .strip_prefix("refs/heads/")
                .zip(current_branch)
                .is_some_and(|(name, current)| name == current);
            Some(GitGraphRef {
                name: short_ref_name(&full_name),
                full_name: full_name.clone(),
                hash: hash.to_owned(),
                kind: ref_kind(&full_name).to_owned(),
                is_current,
                symbolic_target: (!fields[3].is_empty()).then(|| fields[3].to_owned()),
            })
        })
        .collect()
}

pub(crate) fn git_graph_at(
    workspace: &Path,
    limit: Option<usize>,
) -> Result<GitGraphSnapshot, String> {
    let limit = limit
        .unwrap_or(DEFAULT_GRAPH_LIMIT)
        .clamp(1, MAX_GRAPH_LIMIT);
    let current_branch = run_git(workspace, &["symbolic-ref", "--quiet", "--short", "HEAD"])
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    let head = run_git(workspace, &["rev-parse", "--verify", "HEAD"])
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());

    let refs_output = run_git_limited(
        workspace,
        &[
            "for-each-ref",
            "--format=%(refname)%1f%(objectname)%1f%(HEAD)%1f%(symref)%1f%(*objectname)%1e",
            "refs/heads",
            "refs/remotes",
            "refs/tags",
        ],
        MAX_GRAPH_OUTPUT_BYTES,
        "Git graph references",
    )?;
    let mut refs = parse_refs(&refs_output, current_branch.as_deref());

    if let Some(head_hash) = head.as_ref() {
        refs.insert(
            0,
            GitGraphRef {
                name: "HEAD".into(),
                full_name: "HEAD".into(),
                hash: head_hash.clone(),
                kind: "head".into(),
                is_current: true,
                symbolic_target: current_branch
                    .as_ref()
                    .map(|branch| format!("refs/heads/{branch}")),
            },
        );
    }

    let Some(_) = head else {
        return Ok(GitGraphSnapshot {
            head: None,
            current_branch,
            commits: Vec::new(),
            refs,
            truncated: false,
        });
    };

    let requested = limit.saturating_add(1);
    let max_count = format!("--max-count={requested}");
    let args = [
        "log",
        "--topo-order",
        "--all",
        "HEAD",
        max_count.as_str(),
        "--date=iso-strict",
        "--no-show-signature",
        "--no-color",
        "--pretty=format:%x1e%H%x1f%h%x1f%P%x1f%an%x1f%aI%x1f%s",
    ];
    let output = run_git_limited(
        workspace,
        &args,
        MAX_GRAPH_OUTPUT_BYTES,
        "Git graph history",
    )?;
    let mut commits = parse_commits(&output);
    let truncated = commits.len() > limit;
    commits.truncate(limit);

    Ok(GitGraphSnapshot {
        head,
        current_branch,
        commits,
        refs,
        truncated,
    })
}

#[tauri::command]
pub(crate) fn git_graph(
    path: String,
    limit: Option<usize>,
    access: State<'_, WorkspaceAccess>,
) -> Result<GitGraphSnapshot, String> {
    let workspace = access.resolve(&path)?;
    git_graph_at(&workspace, limit)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::process::Command;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TestRepository(PathBuf);

    impl TestRepository {
        fn new() -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock should be valid")
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "traceframe-git-graph-test-{}-{nonce}",
                std::process::id()
            ));
            fs::create_dir_all(&path).expect("test repository should be created");
            Self(path)
        }

        fn git(&self, args: &[&str]) {
            let result = Command::new("git")
                .arg("-C")
                .arg(&self.0)
                .args(args)
                .env("GIT_AUTHOR_NAME", "Traceframe Test")
                .env("GIT_AUTHOR_EMAIL", "traceframe@example.com")
                .env("GIT_COMMITTER_NAME", "Traceframe Test")
                .env("GIT_COMMITTER_EMAIL", "traceframe@example.com")
                .output()
                .expect("git should start");
            assert!(
                result.status.success(),
                "git {:?} failed: {}",
                args,
                String::from_utf8_lossy(&result.stderr)
            );
        }

        fn write_and_commit(&self, file: &str, body: &str, message: &str) {
            fs::write(self.0.join(file), body).expect("fixture should be written");
            self.git(&["add", file]);
            self.git(&["commit", "-m", message]);
        }
    }

    impl Drop for TestRepository {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn parses_commit_parents_without_flattening_merges() {
        let commits = parse_commits(concat!(
            "\x1eaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\x1faaaaaaa\x1f",
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb cccccccccccccccccccccccccccccccccccccccc",
            "\x1fAda\x1f2026-11-07T09:00:00Z\x1fmerge feature",
        ));
        assert_eq!(commits.len(), 1);
        assert_eq!(commits[0].parents.len(), 2);
        assert_eq!(commits[0].subject, "merge feature");
    }

    #[test]
    fn classifies_local_remote_and_tag_refs() {
        let refs = parse_refs(
            concat!(
                "refs/heads/main\x1faaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\x1f*\x1f\x1f\x1e\n",
                "refs/remotes/origin/main\x1faaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\x1f \x1f\x1f\x1e\n",
                "refs/tags/v1.0.0\x1fbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\x1f \x1f\x1faaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\x1e\n",
            ),
            Some("main"),
        );
        assert_eq!(
            refs.iter()
                .map(|item| item.kind.as_str())
                .collect::<Vec<_>>(),
            vec!["local", "remote", "tag"]
        );
        assert!(refs[0].is_current);
        assert_eq!(refs[1].name, "origin/main");
        assert_eq!(refs[2].hash, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    }

    #[test]
    fn peels_annotated_tags_to_the_commit_they_describe() {
        let repo = TestRepository::new();
        repo.git(&["init", "-b", "main"]);
        repo.write_and_commit("release.txt", "release\n", "release");
        repo.git(&["tag", "-a", "v1.0.0", "-m", "release v1"]);

        let graph = git_graph_at(&repo.0, Some(20)).expect("graph should load");
        let head = graph.head.as_deref().expect("head should exist");
        let tag = graph
            .refs
            .iter()
            .find(|reference| reference.full_name == "refs/tags/v1.0.0")
            .expect("annotated tag should be returned");

        assert_eq!(tag.kind, "tag");
        assert_eq!(tag.hash, head);
        assert!(graph.commits.iter().any(|commit| commit.hash == tag.hash));
    }

    #[test]
    fn reads_merge_topology_and_real_branch_refs() {
        let repo = TestRepository::new();
        repo.git(&["init", "-b", "main"]);
        repo.write_and_commit("base.txt", "base\n", "base");
        repo.git(&["switch", "-c", "feature/graph"]);
        repo.write_and_commit("feature.txt", "feature\n", "feature");
        repo.git(&["switch", "main"]);
        repo.write_and_commit("main.txt", "main\n", "main");
        repo.git(&["merge", "--no-ff", "feature/graph", "-m", "merge graph"]);
        repo.git(&["update-ref", "refs/remotes/origin/main", "HEAD"]);

        let graph = git_graph_at(&repo.0, Some(20)).expect("graph should load");
        assert_eq!(graph.current_branch.as_deref(), Some("main"));
        assert_eq!(graph.commits[0].subject, "merge graph");
        assert_eq!(graph.commits[0].parents.len(), 2);
        assert!(graph
            .refs
            .iter()
            .any(|reference| { reference.kind == "local" && reference.name == "feature/graph" }));
        assert!(graph
            .refs
            .iter()
            .any(|reference| { reference.kind == "remote" && reference.name == "origin/main" }));
        assert!(graph.refs.iter().any(|reference| {
            reference.kind == "head" && reference.hash == graph.commits[0].hash
        }));

        let bounded = git_graph_at(&repo.0, Some(1)).expect("bounded graph should load");
        assert_eq!(bounded.commits.len(), 1);
        assert!(bounded.truncated);
    }

    #[test]
    fn handles_an_unborn_branch() {
        let repo = TestRepository::new();
        repo.git(&["init", "-b", "main"]);

        let graph = git_graph_at(&repo.0, None).expect("empty graph should load");
        assert_eq!(graph.current_branch.as_deref(), Some("main"));
        assert!(graph.head.is_none());
        assert!(graph.commits.is_empty());
        assert!(!graph.truncated);
    }
}
