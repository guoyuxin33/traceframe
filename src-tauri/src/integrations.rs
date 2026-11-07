use futures_util::StreamExt;
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tauri_plugin_dialog::DialogExt;

const MAX_SKILLS: usize = 256;
const MAX_SKILL_DEPTH: usize = 6;
const MAX_SKILL_BYTES: u64 = 256 * 1024;
const MAX_ACTIVE_SKILLS: usize = 16;
const MAX_ACTIVE_SKILL_BYTES: usize = 512 * 1024;
const MAX_MCP_RESPONSE_BYTES: usize = 1024 * 1024;
const MCP_TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDescriptor {
    pub id: String,
    pub name: String,
    pub description: String,
    pub path: String,
    pub source_root: String,
    #[serde(default = "enabled_by_default")]
    pub enabled: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSkill {
    pub id: String,
    pub name: String,
    pub path: String,
    #[serde(default = "enabled_by_default")]
    pub enabled: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum McpApprovalPolicy {
    Always,
    Never,
}

impl Default for McpApprovalPolicy {
    fn default() -> Self {
        Self::Always
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeMcpServer {
    pub id: String,
    pub name: String,
    pub server_label: String,
    pub server_url: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub authorization: String,
    #[serde(default)]
    pub allowed_tools: Vec<String>,
    #[serde(default)]
    pub approval_policy: McpApprovalPolicy,
    #[serde(default = "enabled_by_default")]
    pub enabled: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpHealthConfig {
    pub server_label: String,
    pub server_url: String,
    #[serde(default)]
    pub authorization: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpHealth {
    pub ok: bool,
    pub reachable: bool,
    pub latency: u64,
    pub status: Option<u16>,
    pub detail: String,
}

fn enabled_by_default() -> bool {
    true
}

fn clean_frontmatter_value(value: &str) -> String {
    value
        .trim()
        .trim_matches(|character| character == '"' || character == '\'')
        .chars()
        .take(400)
        .collect()
}

fn skill_metadata(contents: &str, fallback_name: &str) -> (String, String) {
    let mut name = String::new();
    let mut description = String::new();
    let mut lines = contents.lines();
    if lines.next().is_some_and(|line| line.trim() == "---") {
        for line in lines.by_ref() {
            let line = line.trim();
            if line == "---" {
                break;
            }
            if let Some(value) = line.strip_prefix("name:") {
                name = clean_frontmatter_value(value);
            } else if let Some(value) = line.strip_prefix("description:") {
                description = clean_frontmatter_value(value);
            }
        }
    }
    if name.is_empty() {
        name = fallback_name.to_owned();
    }
    (name, description)
}

fn skipped_directory(name: &str) -> bool {
    matches!(name, ".git" | "node_modules" | "target" | "dist" | "build")
}

fn find_skill_files(
    directory: &Path,
    depth: usize,
    output: &mut Vec<PathBuf>,
) -> Result<(), String> {
    if depth > MAX_SKILL_DEPTH || output.len() >= MAX_SKILLS {
        return Ok(());
    }
    let mut entries = fs::read_dir(directory)
        .map_err(|error| format!("Skill folder could not be read: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Skill folder entry could not be read: {error}"))?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        if output.len() >= MAX_SKILLS {
            break;
        }
        let file_type = entry
            .file_type()
            .map_err(|error| format!("Skill folder entry could not be inspected: {error}"))?;
        if file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        if file_type.is_file() && entry.file_name() == "SKILL.md" {
            output.push(path);
        } else if file_type.is_dir() {
            let name = entry.file_name();
            if !skipped_directory(&name.to_string_lossy()) {
                find_skill_files(&path, depth + 1, output)?;
            }
        }
    }
    Ok(())
}

fn read_skill(path: &Path, source_root: &Path) -> Result<SkillDescriptor, String> {
    let metadata = fs::metadata(path)
        .map_err(|error| format!("Skill file could not be inspected: {error}"))?;
    if !metadata.is_file() || metadata.len() > MAX_SKILL_BYTES {
        return Err(format!(
            "{} exceeds the {} KiB skill limit",
            path.display(),
            MAX_SKILL_BYTES / 1024
        ));
    }
    let contents = fs::read_to_string(path)
        .map_err(|error| format!("Skill file must be UTF-8 text: {error}"))?;
    let fallback = path
        .parent()
        .and_then(Path::file_name)
        .and_then(|name| name.to_str())
        .unwrap_or("Local skill");
    let (name, description) = skill_metadata(&contents, fallback);
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("Skill file is unavailable: {error}"))?;
    Ok(SkillDescriptor {
        id: canonical.to_string_lossy().to_string(),
        name,
        description,
        path: canonical.to_string_lossy().to_string(),
        source_root: source_root.to_string_lossy().to_string(),
        enabled: true,
    })
}

fn discover_skills_at(root: &Path) -> Result<Vec<SkillDescriptor>, String> {
    let root = root
        .canonicalize()
        .map_err(|error| format!("Skill folder is unavailable: {error}"))?;
    if !root.is_dir() {
        return Err("Skill root must be a directory".into());
    }
    let mut files = Vec::new();
    find_skill_files(&root, 0, &mut files)?;
    let mut skills = files
        .iter()
        .filter_map(|path| read_skill(path, &root).ok())
        .collect::<Vec<_>>();
    skills.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
    Ok(skills)
}

#[tauri::command]
pub async fn pick_skill_directory(
    app: tauri::AppHandle,
    window: tauri::Window,
) -> Result<Option<String>, String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("Add a Traceframe skill folder")
        .set_parent(&window)
        .pick_folder(move |selected| {
            let _ = sender.send(selected);
        });
    let selected = receiver
        .await
        .map_err(|_| "Skill folder picker closed without returning a result".to_string())?;
    selected
        .map(|path| {
            let local = path
                .as_path()
                .ok_or_else(|| "Only local skill folders are supported".to_string())?;
            let canonical = local
                .canonicalize()
                .map_err(|error| format!("Skill folder is unavailable: {error}"))?;
            if !canonical.is_dir() {
                return Err("Skill root must be a directory".into());
            }
            Ok(canonical.to_string_lossy().to_string())
        })
        .transpose()
}

#[tauri::command]
pub async fn discover_skills(root: String) -> Result<Vec<SkillDescriptor>, String> {
    tokio::task::spawn_blocking(move || discover_skills_at(Path::new(&root)))
        .await
        .map_err(|error| format!("Skill discovery task failed: {error}"))?
}

fn validated_mcp_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value.trim()).map_err(|error| format!("MCP URL is invalid: {error}"))?;
    let host = url
        .host_str()
        .ok_or_else(|| "MCP URL must include a host".to_string())?;
    let loopback = matches!(host, "localhost" | "127.0.0.1" | "::1" | "[::1]");
    if url.scheme() != "https" && !(url.scheme() == "http" && loopback) {
        return Err("Remote MCP servers must use HTTPS; HTTP is limited to loopback".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("MCP credentials must not be embedded in the URL".into());
    }
    if url.fragment().is_some() {
        return Err("MCP URL must not include a fragment".into());
    }
    Ok(url)
}

fn validated_server_label(value: &str) -> Result<&str, String> {
    let label = value.trim();
    if label.is_empty()
        || label.len() > 64
        || !label
            .bytes()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, b'_' | b'-'))
    {
        return Err(
            "MCP server label must use 1-64 letters, numbers, underscores, or hyphens".into(),
        );
    }
    Ok(label)
}

fn authorization_token(value: &str) -> Result<Option<&str>, String> {
    let value = value.trim();
    if value.is_empty() {
        return Ok(None);
    }
    if value.contains(['\r', '\n']) {
        return Err("MCP authorization token contains invalid characters".into());
    }
    let token = if value
        .get(..7)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("bearer "))
    {
        value.get(7..).unwrap_or_default().trim()
    } else {
        value
    };
    if token.is_empty() {
        return Err("MCP authorization token is empty".into());
    }
    Ok(Some(token))
}

async fn bounded_response(response: reqwest::Response) -> Result<Vec<u8>, String> {
    let mut stream = response.bytes_stream();
    let mut output = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| format!("MCP response could not be read: {error}"))?;
        if output.len().saturating_add(chunk.len()) > MAX_MCP_RESPONSE_BYTES {
            return Err("MCP response exceeded the 1 MiB health-check limit".into());
        }
        output.extend_from_slice(&chunk);
    }
    Ok(output)
}

fn parse_mcp_response(content_type: &str, body: &[u8]) -> Result<Value, String> {
    if content_type.contains("text/event-stream") {
        let text = std::str::from_utf8(body)
            .map_err(|_| "MCP event stream was not valid UTF-8".to_string())?;
        for line in text.lines() {
            if let Some(data) = line.strip_prefix("data:") {
                let data = data.trim();
                if !data.is_empty() && data != "[DONE]" {
                    return serde_json::from_str(data).map_err(|error| {
                        format!("MCP initialize event was invalid JSON: {error}")
                    });
                }
            }
        }
        return Err("MCP event stream did not include an initialize response".into());
    }
    serde_json::from_slice(body)
        .map_err(|error| format!("MCP initialize response was invalid JSON: {error}"))
}

#[tauri::command]
pub async fn mcp_healthcheck(server: McpHealthConfig) -> Result<McpHealth, String> {
    let started = Instant::now();
    let label = validated_server_label(&server.server_label)?;
    let url = validated_mcp_url(&server.server_url)?;
    let client = Client::builder()
        .timeout(MCP_TIMEOUT)
        .build()
        .map_err(|error| format!("MCP HTTP client could not be created: {error}"))?;
    let mut request = client
        .post(url)
        .header("accept", "application/json, text/event-stream")
        .header("content-type", "application/json")
        .json(&json!({
            "jsonrpc": "2.0",
            "id": "traceframe-healthcheck",
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-03-26",
                "capabilities": {},
                "clientInfo": { "name": "Traceframe", "version": env!("CARGO_PKG_VERSION") }
            }
        }));
    if let Some(token) = authorization_token(&server.authorization)? {
        request = request.bearer_auth(token);
    }
    let response = request
        .send()
        .await
        .map_err(|error| format!("MCP server could not be reached: {error}"))?;
    let status = response.status();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_owned();
    let body = bounded_response(response).await?;
    let latency = started.elapsed().as_millis() as u64;
    if !status.is_success() {
        let detail = String::from_utf8_lossy(&body)
            .chars()
            .take(300)
            .collect::<String>();
        return Ok(McpHealth {
            ok: false,
            reachable: true,
            latency,
            status: Some(status.as_u16()),
            detail: if detail.trim().is_empty() {
                format!("{label} returned HTTP {}", status.as_u16())
            } else {
                format!("{label} returned HTTP {}: {detail}", status.as_u16())
            },
        });
    }
    let value = parse_mcp_response(&content_type, &body)?;
    if let Some(error) = value.get("error") {
        return Ok(McpHealth {
            ok: false,
            reachable: true,
            latency,
            status: Some(status.as_u16()),
            detail: format!("{label} rejected initialize: {error}"),
        });
    }
    if value.get("result").is_none() {
        return Err("MCP initialize response did not contain a result".into());
    }
    Ok(McpHealth {
        ok: true,
        reachable: true,
        latency,
        status: Some(status.as_u16()),
        detail: format!("{label} accepted MCP initialize in {latency} ms"),
    })
}

pub fn load_skill_instructions(skills: &[RuntimeSkill]) -> Result<String, String> {
    let mut total_bytes = 0usize;
    let mut sections = Vec::new();
    for skill in skills
        .iter()
        .filter(|skill| skill.enabled)
        .take(MAX_ACTIVE_SKILLS)
    {
        let path = Path::new(&skill.path)
            .canonicalize()
            .map_err(|error| format!("Enabled skill '{}' is unavailable: {error}", skill.name))?;
        if path.file_name().and_then(|name| name.to_str()) != Some("SKILL.md") {
            return Err(format!(
                "Enabled skill '{}' does not point to SKILL.md",
                skill.name
            ));
        }
        let metadata = fs::metadata(&path).map_err(|error| {
            format!(
                "Enabled skill '{}' could not be inspected: {error}",
                skill.name
            )
        })?;
        if metadata.len() > MAX_SKILL_BYTES {
            return Err(format!(
                "Enabled skill '{}' exceeds the per-skill size limit",
                skill.name
            ));
        }
        total_bytes = total_bytes.saturating_add(metadata.len() as usize);
        if total_bytes > MAX_ACTIVE_SKILL_BYTES {
            return Err("Enabled skills exceed the 512 KiB run limit".into());
        }
        let contents = fs::read_to_string(&path).map_err(|error| {
            format!("Enabled skill '{}' could not be read: {error}", skill.name)
        })?;
        sections.push(format!(
            "<skill id=\"{}\" name=\"{}\">\n{}\n</skill>",
            skill.id.replace('"', ""),
            skill.name.replace('"', ""),
            contents.trim()
        ));
    }
    Ok(sections.join("\n\n"))
}

pub fn responses_mcp_tools(
    servers: &[RuntimeMcpServer],
    full_access: bool,
) -> Result<Vec<Value>, String> {
    servers
        .iter()
        .filter(|server| server.enabled)
        .map(|server| {
            (|| {
                let label = validated_server_label(&server.server_label)?;
                let url = validated_mcp_url(&server.server_url)?;
                let mut tool = json!({
                    "type": "mcp",
                    "server_label": label,
                    "server_url": url.as_str(),
                    "require_approval": if full_access && server.approval_policy == McpApprovalPolicy::Never {
                        "never"
                    } else {
                        "always"
                    }
                });
                if !server.description.trim().is_empty() {
                    tool["server_description"] = json!(server.description.trim());
                }
                if !server.allowed_tools.is_empty() {
                    tool["allowed_tools"] = json!(server.allowed_tools);
                }
                if let Some(token) = authorization_token(&server.authorization)? {
                    tool["authorization"] = json!(token);
                }
                Ok(tool)
            })()
            .map_err(|error: String| {
                format!(
                    "MCP server '{}' ({}) is invalid: {error}",
                    server.name.trim(),
                    server.id
                )
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{
        discover_skills_at, load_skill_instructions, responses_mcp_tools, validated_mcp_url,
        McpApprovalPolicy, RuntimeMcpServer, RuntimeSkill,
    };
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temporary_directory() -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("traceframe-integrations-{nonce}"));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn discovers_frontmatter_and_loads_selected_skill_content() {
        let root = temporary_directory();
        let directory = root.join("review");
        fs::create_dir_all(&directory).unwrap();
        fs::write(
            directory.join("SKILL.md"),
            "---\nname: Review carefully\ndescription: Check behavior before style\n---\n# Instructions\nVerify tests.\n",
        )
        .unwrap();

        let skills = discover_skills_at(&root).unwrap();
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].name, "Review carefully");
        assert_eq!(skills[0].description, "Check behavior before style");
        let loaded = load_skill_instructions(&[RuntimeSkill {
            id: skills[0].id.clone(),
            name: skills[0].name.clone(),
            path: skills[0].path.clone(),
            enabled: true,
        }])
        .unwrap();
        assert!(loaded.contains("Verify tests."));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_insecure_remote_mcp_urls() {
        assert!(validated_mcp_url("http://example.com/mcp").is_err());
        assert!(validated_mcp_url("http://127.0.0.1:9000/mcp").is_ok());
        assert!(validated_mcp_url("https://example.com/mcp").is_ok());
        assert!(validated_mcp_url("https://user:pass@example.com/mcp").is_err());
    }

    #[test]
    fn global_permission_mode_caps_mcp_full_access() {
        let server = RuntimeMcpServer {
            id: "docs".into(),
            name: "Docs".into(),
            server_label: "docs".into(),
            server_url: "https://example.com/mcp".into(),
            description: "Documentation".into(),
            authorization: "secret".into(),
            allowed_tools: vec!["search".into()],
            approval_policy: McpApprovalPolicy::Never,
            enabled: true,
        };
        let guarded = responses_mcp_tools(std::slice::from_ref(&server), false).unwrap();
        assert_eq!(guarded[0]["require_approval"], "always");
        let trusted = responses_mcp_tools(&[server], true).unwrap();
        assert_eq!(trusted[0]["require_approval"], "never");
        assert_eq!(trusted[0]["allowed_tools"][0], "search");
        assert_eq!(trusted[0]["authorization"], "secret");
    }
}
