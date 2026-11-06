use crate::store::{AppStore, MemoryRecord, MessageRecord, NewMessage};
use crate::{
    create_workspace_file_at, git_diff_at, git_snapshot_at, read_workspace_file_at,
    safe_relative_path, workspace_tree_at, write_workspace_file_at, WorkspaceAccess,
};
use futures_util::StreamExt;
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::hash_map::Entry;
use std::collections::HashMap;
use std::future::Future;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{ipc::Channel, State};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::{Child, Command};

const MAX_ERROR_BYTES: usize = 64 * 1024;
const MAX_STREAM_BYTES: usize = 8 * 1024 * 1024;
const MAX_COMMAND_OUTPUT_BYTES: usize = 1024 * 1024;
const MAX_MODEL_TOOL_OUTPUT_CHARS: usize = 16_000;
const MAX_TOOL_ROUNDS: usize = 16;
const MAX_CHILD_TOOL_ROUNDS: usize = 8;
const MAX_DELEGATED_AGENTS: usize = 4;
const MAX_COMMAND_ARGS: usize = 64;
const MAX_SUMMARY_CHARS: usize = 4_000;
const MAX_MESSAGE_CHARS: usize = 2_000;
const MAX_MEMORY_TITLE_CHARS: usize = 120;
const MAX_MEMORY_DETAIL_CHARS: usize = 600;
const ANTHROPIC_MAX_TOKENS: u32 = 4_096;
const HEALTHCHECK_TIMEOUT: Duration = Duration::from_secs(5);
const CHILD_EXIT_TIMEOUT: Duration = Duration::from_secs(2);
const DEFAULT_COMMAND_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Default)]
pub struct RuntimeControl {
    cancellations: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl RuntimeControl {
    fn register(&self, run_id: &str) -> Result<Arc<AtomicBool>, String> {
        let mut runs = self
            .cancellations
            .lock()
            .map_err(|_| "Runtime cancellation state is unavailable".to_string())?;
        match runs.entry(run_id.to_owned()) {
            Entry::Occupied(_) => Err("A run with this ID is already active".into()),
            Entry::Vacant(entry) => {
                let cancellation = Arc::new(AtomicBool::new(false));
                entry.insert(cancellation.clone());
                Ok(cancellation)
            }
        }
    }

    fn unregister(&self, run_id: &str, cancellation: &Arc<AtomicBool>) {
        if let Ok(mut runs) = self.cancellations.lock() {
            let owns_registration = runs
                .get(run_id)
                .is_some_and(|current| Arc::ptr_eq(current, cancellation));
            if owns_registration {
                runs.remove(run_id);
            }
        }
    }
}

struct RunRegistration<'a> {
    control: &'a RuntimeControl,
    run_id: String,
    cancellation: Arc<AtomicBool>,
}

impl Drop for RunRegistration<'_> {
    fn drop(&mut self) {
        self.control.unregister(&self.run_id, &self.cancellation);
    }
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    pub id: String,
    pub name: String,
    pub endpoint: String,
    pub model: String,
    #[serde(default = "default_adapter")]
    pub adapter: String,
    #[serde(default)]
    pub api_key: String,
}

fn default_adapter() -> String {
    "openai-chat".into()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeRequest {
    pub run_id: String,
    pub session_id: String,
    pub workspace_path: String,
    pub branch: String,
    pub prompt: String,
    pub provider: ProviderConfig,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderHealth {
    pub ok: bool,
    pub reachable: bool,
    pub authenticated: Option<bool>,
    pub latency: u64,
    pub status: Option<u16>,
    pub detail: String,
    pub models: Vec<String>,
}

fn extract_models(value: &Value) -> Vec<String> {
    let entries = value
        .get("data")
        .or_else(|| value.get("models"))
        .and_then(Value::as_array);
    let mut models = entries
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            entry.as_str().map(str::to_owned).or_else(|| {
                entry
                    .get("id")
                    .or_else(|| entry.get("name"))
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
        })
        .map(|model| model.trim().to_owned())
        .filter(|model| !model.is_empty())
        .collect::<Vec<_>>();
    models.sort();
    models.dedup();
    models
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamEvent {
    pub id: String,
    pub run_id: String,
    pub session_id: String,
    pub sequence: u64,
    #[serde(rename = "type")]
    pub event_type: String,
    pub payload: Value,
    pub timestamp: u64,
}

fn api_url(endpoint: &str, suffix: &str) -> Result<Url, String> {
    let endpoint = endpoint.trim().trim_end_matches('/');
    if endpoint.is_empty() {
        return Err("Provider endpoint is required".into());
    }
    let url = Url::parse(&format!("{endpoint}/{suffix}"))
        .map_err(|error| format!("Provider endpoint is invalid: {error}"))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("Provider endpoint must be an HTTP or HTTPS URL".into());
    }
    let host = url.host_str().unwrap_or_default();
    let is_loopback = matches!(host, "localhost" | "127.0.0.1" | "::1" | "[::1]");
    if url.scheme() == "http" && !is_loopback {
        return Err("Remote provider endpoints must use HTTPS".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Provider endpoint cannot contain credentials".into());
    }
    Ok(url)
}

fn provider_api_url(provider: &ProviderConfig, suffix: &str) -> Result<Url, String> {
    let url = api_url(&provider.endpoint, suffix)?;
    if provider.adapter == "cc-switch-responses"
        && !matches!(
            url.host_str(),
            Some("localhost" | "127.0.0.1" | "::1" | "[::1]")
        )
    {
        return Err("CC Switch must use a loopback endpoint".into());
    }
    Ok(url)
}

fn client() -> Result<Client, String> {
    Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(600))
        .user_agent("Traceframe/0.3")
        .build()
        .map_err(|error| format!("Provider client could not be created: {error}"))
}

fn authorize(
    request: reqwest::RequestBuilder,
    provider: &ProviderConfig,
) -> reqwest::RequestBuilder {
    if provider.adapter == "cc-switch-responses" {
        request
    } else if provider.adapter == "anthropic" {
        let request = request.header("anthropic-version", "2023-06-01");
        if provider.api_key.trim().is_empty() {
            request
        } else {
            request.header("x-api-key", provider.api_key.trim())
        }
    } else if provider.api_key.trim().is_empty() {
        request
    } else {
        request.bearer_auth(provider.api_key.trim())
    }
}

async fn bounded_body(response: reqwest::Response, limit: usize) -> Result<Vec<u8>, String> {
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| format!("Provider body could not be read: {error}"))?;
        let remaining = limit.saturating_sub(bytes.len());
        if remaining == 0 {
            break;
        }
        bytes.extend_from_slice(&chunk[..chunk.len().min(remaining)]);
        if bytes.len() >= limit {
            break;
        }
    }
    Ok(bytes)
}

async fn bounded_error(response: reqwest::Response) -> String {
    let status = response.status();
    let bytes = bounded_body(response, MAX_ERROR_BYTES)
        .await
        .unwrap_or_default();
    let detail = String::from_utf8_lossy(&bytes).trim().to_owned();
    if detail.is_empty() {
        format!("Provider returned {status}")
    } else {
        format!("Provider returned {status}: {detail}")
    }
}

#[tauri::command]
pub async fn provider_healthcheck(provider: ProviderConfig) -> Result<ProviderHealth, String> {
    provider_healthcheck_with_timeout(provider, HEALTHCHECK_TIMEOUT).await
}

async fn provider_healthcheck_with_timeout(
    provider: ProviderConfig,
    timeout: Duration,
) -> Result<ProviderHealth, String> {
    let started = Instant::now();
    let is_cc_switch = provider.adapter == "cc-switch-responses";
    let url = if is_cc_switch {
        let mut url = provider_api_url(&provider, "responses")?;
        url.set_path("/health");
        url.set_query(None);
        url
    } else {
        api_url(&provider.endpoint, "models")?
    };
    tokio::time::timeout(timeout, async {
        let response = authorize(client()?.get(url), &provider)
            .send()
            .await
            .map_err(|error| format!("Provider is unreachable: {error}"))?;
        let latency = started.elapsed().as_millis() as u64;
        let status = response.status();
        if response.status().is_success() {
            if is_cc_switch {
                let body = bounded_body(response, MAX_ERROR_BYTES).await?;
                let healthy = serde_json::from_slice::<Value>(&body)
                    .ok()
                    .and_then(|value| {
                        value
                            .get("status")
                            .and_then(Value::as_str)
                            .map(str::to_owned)
                    })
                    .is_some_and(|status| status == "healthy");
                let (models, discovery_error) = if healthy {
                    let models_url = provider_api_url(&provider, "models")?;
                    let models_response = authorize(client()?.get(models_url), &provider)
                        .send()
                        .await
                        .map_err(|error| format!("CC Switch model discovery failed: {error}"))?;
                    if models_response.status().is_success() {
                        let body = bounded_body(models_response, MAX_ERROR_BYTES).await?;
                        (
                            serde_json::from_slice::<Value>(&body)
                                .ok()
                                .map(|value| extract_models(&value))
                                .unwrap_or_default(),
                            None,
                        )
                    } else {
                        (Vec::new(), Some(bounded_error(models_response).await))
                    }
                } else {
                    (Vec::new(), None)
                };
                return Ok(ProviderHealth {
                    ok: healthy,
                    reachable: true,
                    authenticated: None,
                    latency,
                    status: Some(status.as_u16()),
                    detail: if let Some(error) = discovery_error {
                        format!("CC Switch is healthy; model discovery failed: {error}")
                    } else if healthy {
                        if models.is_empty() {
                            "CC Switch is healthy; no models were advertised, so enter a current model name"
                                .into()
                        } else {
                            format!("CC Switch is healthy; discovered {} models", models.len())
                        }
                    } else {
                        "CC Switch responded but did not report a healthy service".into()
                    },
                    models,
                });
            }
            let body = bounded_body(response, MAX_ERROR_BYTES).await?;
            let models = serde_json::from_slice::<Value>(&body)
                .ok()
                .map(|value| extract_models(&value))
                .unwrap_or_default();
            Ok(ProviderHealth {
                ok: true,
                reachable: true,
                authenticated: if is_cc_switch {
                    Some(true)
                } else if provider.api_key.trim().is_empty() {
                    None
                } else {
                    Some(true)
                },
                latency,
                status: Some(status.as_u16()),
                detail: if is_cc_switch {
                    "CC Switch local Responses route is ready".into()
                } else if provider.api_key.trim().is_empty() {
                    format!(
                        "{} is reachable; credentials were not supplied",
                        provider.name
                    )
                } else {
                    format!("{} accepted the configured credentials", provider.name)
                },
                models,
            })
        } else if matches!(status.as_u16(), 401 | 403) {
            Ok(ProviderHealth {
                ok: false,
                reachable: true,
                authenticated: Some(false),
                latency,
                status: Some(status.as_u16()),
                detail: if provider.api_key.trim().is_empty() {
                    "Endpoint is reachable; an API key is required".into()
                } else {
                    "Endpoint is reachable; the API key was rejected".into()
                },
                models: Vec::new(),
            })
        } else {
            Ok(ProviderHealth {
                ok: false,
                reachable: true,
                authenticated: None,
                latency,
                status: Some(status.as_u16()),
                detail: bounded_error(response).await,
                models: Vec::new(),
            })
        }
    })
    .await
    .map_err(|_| {
        format!(
            "Provider healthcheck timed out after {} milliseconds",
            timeout.as_millis()
        )
    })?
}

fn emit(
    channel: &Channel<StreamEvent>,
    store: &AppStore,
    request: &RuntimeRequest,
    sequence: &mut u64,
    event_type: &str,
    payload: Value,
) -> Result<(), String> {
    let record = store.append_event(
        &request.session_id,
        &request.run_id,
        *sequence,
        event_type,
        &payload,
    )?;
    let event = StreamEvent {
        id: record.id,
        run_id: request.run_id.clone(),
        session_id: request.session_id.clone(),
        sequence: *sequence,
        event_type: event_type.to_owned(),
        payload,
        timestamp: record.created_at,
    };
    *sequence += 1;
    channel
        .send(event)
        .map_err(|error| format!("Runtime event could not be delivered: {error}"))
}

fn emit_run_failed(
    channel: &Channel<StreamEvent>,
    store: &AppStore,
    request: &RuntimeRequest,
    sequence: &mut u64,
    error: &str,
) {
    let _ = emit(
        channel,
        store,
        request,
        sequence,
        "run.failed",
        json!({ "error": error }),
    );
}

fn delta_from_chunk(value: &Value) -> Option<&str> {
    value
        .pointer("/choices/0/delta/content")
        .and_then(Value::as_str)
}

fn usage_from_chunk(value: &Value) -> Option<Value> {
    value.get("usage").filter(|usage| !usage.is_null()).cloned()
}

fn anthropic_delta(value: &Value) -> Option<&str> {
    if value.get("type").and_then(Value::as_str) != Some("content_block_delta")
        || value.pointer("/delta/type").and_then(Value::as_str) != Some("text_delta")
    {
        return None;
    }
    value.pointer("/delta/text").and_then(Value::as_str)
}

fn anthropic_usage(value: &Value) -> Option<&Value> {
    match value.get("type").and_then(Value::as_str) {
        Some("message_start") => value.pointer("/message/usage"),
        Some("message_delta") => value.get("usage"),
        _ => None,
    }
}

fn merge_usage(current: &mut Value, next: &Value) {
    let Some(next) = next.as_object() else {
        return;
    };
    if !current.is_object() {
        *current = json!({});
    }
    if let Some(current) = current.as_object_mut() {
        current.extend(next.iter().map(|(key, value)| (key.clone(), value.clone())));
    }
}

fn anthropic_stream_error(value: &Value) -> Option<String> {
    if value.get("type").and_then(Value::as_str) != Some("error") {
        return None;
    }
    Some(
        value
            .pointer("/error/message")
            .and_then(Value::as_str)
            .unwrap_or("Anthropic returned an unknown streaming error")
            .to_owned(),
    )
}

async fn send_anthropic_request(
    provider: &ProviderConfig,
    system: &str,
    messages: &[Value],
) -> Result<reqwest::Response, String> {
    let url = api_url(&provider.endpoint, "messages")?;
    authorize(client()?.post(url), provider)
        .json(&json!({
            "model": provider.model,
            "system": system,
            "messages": messages,
            "max_tokens": ANTHROPIC_MAX_TOKENS,
            "stream": true
        }))
        .send()
        .await
        .map_err(|error| format!("Anthropic request failed: {error}"))
}

async fn await_cancellable_response<F>(
    request: F,
    cancellation: &AtomicBool,
) -> Result<Option<reqwest::Response>, String>
where
    F: Future<Output = Result<reqwest::Response, String>>,
{
    tokio::pin!(request);
    loop {
        if cancellation.load(Ordering::SeqCst) {
            return Ok(None);
        }
        match tokio::time::timeout(Duration::from_millis(100), request.as_mut()).await {
            Ok(response) => return response.map(Some),
            Err(_) => continue,
        }
    }
}

fn take_sse_block(buffer: &mut Vec<u8>) -> Option<Vec<u8>> {
    let lf = buffer
        .windows(2)
        .position(|window| window == b"\n\n")
        .map(|position| (position, 2));
    let crlf = buffer
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|position| (position, 4));
    let (position, delimiter) = match (lf, crlf) {
        (Some(left), Some(right)) => {
            if left.0 < right.0 {
                left
            } else {
                right
            }
        }
        (Some(found), None) | (None, Some(found)) => found,
        (None, None) => return None,
    };
    let block = buffer.drain(..position).collect::<Vec<_>>();
    buffer.drain(..delimiter.min(buffer.len()));
    Some(block)
}

fn parse_sse_data(block: &[u8]) -> Option<String> {
    let normalized = String::from_utf8_lossy(block).replace("\r\n", "\n");
    let lines = normalized
        .lines()
        .filter_map(|line| line.strip_prefix("data:").map(str::trim_start))
        .collect::<Vec<_>>();
    if lines.is_empty() {
        None
    } else {
        Some(lines.join("\n"))
    }
}

fn truncate_chars(value: &str, limit: usize) -> String {
    let mut truncated = value.chars().take(limit).collect::<String>();
    if value.chars().count() > limit {
        truncated.push_str("...");
    }
    truncated
}

fn model_tool_output(value: &str) -> String {
    if value.chars().count() <= MAX_MODEL_TOOL_OUTPUT_CHARS {
        return value.to_owned();
    }
    json!({
        "truncated": true,
        "notice": "Tool output was shortened for the active model context. Re-run a narrower read, diff, search, or command to inspect the omitted data.",
        "output": truncate_chars(value, MAX_MODEL_TOOL_OUTPUT_CHARS),
    })
    .to_string()
}

fn without_current_prompt<'a>(messages: &'a [MessageRecord], prompt: &str) -> &'a [MessageRecord] {
    match messages.last() {
        Some(message) if message.role == "user" && message.body.trim() == prompt.trim() => {
            &messages[..messages.len() - 1]
        }
        _ => messages,
    }
}

fn summary_for_prompt(summary: &str, prompt: &str) -> String {
    let summary = summary.trim();
    let prompt_prefix = prompt.trim().chars().take(160).collect::<String>();
    if summary.is_empty() || summary == prompt_prefix {
        "(none)".into()
    } else {
        truncate_chars(summary, MAX_SUMMARY_CHARS)
    }
}

fn format_memories(memories: &[MemoryRecord]) -> String {
    if memories.is_empty() {
        return "(none)".into();
    }
    memories
        .iter()
        .map(|memory| {
            format!(
                "- [{} / {}] {}: {}",
                memory.scope,
                memory.kind,
                truncate_chars(memory.title.trim(), MAX_MEMORY_TITLE_CHARS),
                truncate_chars(memory.detail.trim(), MAX_MEMORY_DETAIL_CHARS)
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn agent_instructions(
    request: &RuntimeRequest,
    summary: &str,
    memories: &[MemoryRecord],
) -> String {
    format!(
        "You are the coding agent embedded in Traceframe's transparent desktop workspace.\n\
Repository: {}\n\
Branch: {}\n\
Use the supplied Traceframe tools for all repository claims and changes. Read before editing, make focused changes, run relevant checks, and report the exact files and verification performed. Never claim a file or command changed unless a tool result proves it. Do not access paths outside the authorized workspace.\n\n\
You cannot create or update Traceframe's durable Memory records. Never claim that information was saved for future sessions; ask the user to save it explicitly in the Memory panel.\n\n\
Durable session summary:\n{}\n\n\
Scoped durable memories (the current explicit request wins if any memory conflicts):\n{}",
        request.workspace_path,
        request.branch,
        summary_for_prompt(summary, &request.prompt),
        format_memories(memories)
    )
}

fn specialist_instructions(request: &RuntimeRequest, agent: &AgentContext) -> String {
    let capability = match agent.profile {
        AgentProfile::Scout => {
            "You are read-only. Explore the repository and return findings with exact file evidence."
        }
        AgentProfile::Reviewer => {
            "You are read-only. Review existing work for defects, regressions, and missing verification."
        }
        AgentProfile::Worker => {
            "You may use the host-provided write and command tools needed to complete the scoped task."
        }
        AgentProfile::Root => "Follow the host-provided tool policy.",
    };
    format!(
        "You are {} ({}, {} profile) inside Traceframe, working as a bounded specialist for the root agent.\n\
Repository: {}\n\
Branch: {}\n\
Assigned task: {}\n\
{} Complete only this task. Use the supplied Traceframe tools for every repository claim, and return a concise evidence-backed result for the root agent. You cannot delegate, expand your host-owned profile, or access paths outside the authorized workspace.",
        agent.name,
        agent.role,
        agent.profile.as_str(),
        request.workspace_path,
        request.branch,
        agent.task,
        capability
    )
}

fn responses_input(messages: &[MessageRecord], prompt: &str) -> Vec<Value> {
    let mut input = without_current_prompt(messages, prompt)
        .iter()
        .map(|message| {
            let role = if message.role == "agent" {
                "assistant"
            } else {
                "user"
            };
            let text = if message.role == "system" {
                format!(
                    "Traceframe runtime note: {}",
                    truncate_chars(&message.body, MAX_MESSAGE_CHARS)
                )
            } else {
                truncate_chars(&message.body, MAX_MESSAGE_CHARS)
            };
            json!({ "role": role, "content": text })
        })
        .collect::<Vec<_>>();
    input.push(json!({ "role": "user", "content": prompt.trim() }));
    input
}

#[cfg(unix)]
async fn signal_process_group(process_id: Option<u32>, signal: &str) {
    let Some(process_id) = process_id else {
        return;
    };
    let _ = Command::new("/bin/kill")
        .arg(format!("-{signal}"))
        .arg(format!("-{process_id}"))
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .await;
}

async fn terminate_child(child: &mut Child) -> Result<(), String> {
    let process_id = child.id();
    #[cfg(unix)]
    signal_process_group(process_id, "TERM").await;
    #[cfg(not(unix))]
    let _ = child.start_kill();

    match tokio::time::timeout(CHILD_EXIT_TIMEOUT, child.wait()).await {
        Ok(Ok(_)) => Ok(()),
        Ok(Err(error)) => Err(format!("Child process could not be reaped: {error}")),
        Err(_) => {
            #[cfg(unix)]
            signal_process_group(process_id, "KILL").await;
            let kill_error = child.start_kill().err();
            match tokio::time::timeout(CHILD_EXIT_TIMEOUT, child.wait()).await {
                Ok(Ok(_)) => Ok(()),
                Ok(Err(error)) => Err(format!("Child process could not be reaped: {error}")),
                Err(_) => Err(match kill_error {
                    Some(error) => format!("Child process could not be killed or reaped: {error}"),
                    None => "Child process did not exit after it was killed".into(),
                }),
            }
        }
    }
}

#[derive(Debug)]
struct ToolCall {
    call_id: String,
    name: String,
    arguments: String,
}

#[derive(Debug)]
struct ResponsesRound {
    text: String,
    output_items: Vec<Value>,
    tool_calls: Vec<ToolCall>,
    usage: Value,
}

#[derive(Debug)]
struct ToolExecution {
    output: String,
    changed_files: Vec<ChangedFile>,
    ok: bool,
}

#[derive(Debug)]
struct ChangedFile {
    path: String,
    start_line: usize,
    end_line: usize,
}

#[derive(Debug)]
struct CommandFileState {
    fingerprint: u64,
    start_line: usize,
    end_line: usize,
}

fn changed_line_range(before: &str, after: &str) -> (usize, usize) {
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

    let available_lines = after_lines.len().max(1);
    let start_line = (prefix + 1).min(available_lines);
    let changed_after = after_lines.len().saturating_sub(prefix + suffix);
    let end_line = if changed_after == 0 {
        start_line
    } else {
        (prefix + changed_after).min(available_lines)
    };
    (start_line, end_line.max(start_line))
}

#[derive(Clone, Debug)]
struct AgentContext {
    id: String,
    parent_id: Option<String>,
    name: String,
    role: String,
    task: String,
    allow_delegate: bool,
    profile: AgentProfile,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AgentProfile {
    Root,
    Scout,
    Reviewer,
    Worker,
}

impl AgentProfile {
    fn parse(value: &str) -> Result<Self, String> {
        match value.trim().to_ascii_lowercase().as_str() {
            "scout" => Ok(Self::Scout),
            "reviewer" => Ok(Self::Reviewer),
            "worker" => Ok(Self::Worker),
            _ => Err("delegate_task profile must be scout, reviewer, or worker".into()),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Root => "root",
            Self::Scout => "scout",
            Self::Reviewer => "reviewer",
            Self::Worker => "worker",
        }
    }

    fn allows_tool(self, name: &str) -> bool {
        match self {
            Self::Root | Self::Worker => matches!(
                name,
                "list_files"
                    | "read_file"
                    | "edit_file"
                    | "write_file"
                    | "create_file"
                    | "git_status"
                    | "git_diff"
                    | "run_command"
                    | "delegate_task"
            ),
            Self::Scout | Self::Reviewer => {
                matches!(name, "list_files" | "read_file" | "git_status" | "git_diff")
            }
        }
    }
}

#[derive(Debug)]
struct AgentOutcome {
    text: String,
    rounds: usize,
    usage: Vec<Value>,
}

#[derive(Default)]
struct AgentBudget {
    delegated: usize,
}

fn emit_agent(
    channel: &Channel<StreamEvent>,
    store: &AppStore,
    request: &RuntimeRequest,
    sequence: &mut u64,
    event_type: &str,
    mut payload: Value,
    agent: &AgentContext,
) -> Result<(), String> {
    if let Some(payload) = payload.as_object_mut() {
        payload.insert("agentId".into(), json!(agent.id));
        if let Some(parent_id) = agent.parent_id.as_ref() {
            payload.insert("parentAgentId".into(), json!(parent_id));
        }
    }
    emit(channel, store, request, sequence, event_type, payload)
}

fn tool_definitions(profile: AgentProfile, allow_delegate: bool) -> Vec<Value> {
    let mut tools = vec![
        json!({
            "type": "function",
            "name": "list_files",
            "description": "List the authorized workspace tree. Use query to filter paths, or null for all visible paths.",
            "parameters": {
                "type": "object",
                "properties": { "query": { "type": ["string", "null"] } },
                "required": ["query"],
                "additionalProperties": false
            },
            "strict": true
        }),
        json!({
            "type": "function",
            "name": "read_file",
            "description": "Read an existing UTF-8 text file inside the authorized workspace.",
            "parameters": {
                "type": "object",
                "properties": { "path": { "type": "string" } },
                "required": ["path"],
                "additionalProperties": false
            },
            "strict": true
        }),
        json!({
            "type": "function",
            "name": "edit_file",
            "description": "Replace exact text in an existing UTF-8 file. Read the file first. The edit fails on stale or ambiguous content unless replace_all is true.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "old_text": { "type": "string" },
                    "new_text": { "type": "string" },
                    "replace_all": { "type": "boolean" }
                },
                "required": ["path", "old_text", "new_text", "replace_all"],
                "additionalProperties": false
            },
            "strict": true
        }),
        json!({
            "type": "function",
            "name": "write_file",
            "description": "Replace an existing UTF-8 file atomically. Read the file first and pass its exact content as expected_original_content for conflict detection.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "expected_original_content": { "type": "string" },
                    "new_content": { "type": "string" }
                },
                "required": ["path", "expected_original_content", "new_content"],
                "additionalProperties": false
            },
            "strict": true
        }),
        json!({
            "type": "function",
            "name": "create_file",
            "description": "Create a new UTF-8 text file inside the authorized workspace. The call fails if the file already exists. Missing parent directories are created without following symbolic links.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "content": { "type": "string" }
                },
                "required": ["path", "content"],
                "additionalProperties": false
            },
            "strict": true
        }),
        json!({
            "type": "function",
            "name": "git_status",
            "description": "Read the current branch and staged, unstaged, and untracked file state.",
            "parameters": {
                "type": "object",
                "properties": {},
                "required": [],
                "additionalProperties": false
            },
            "strict": true
        }),
        json!({
            "type": "function",
            "name": "git_diff",
            "description": "Read a bounded Git diff for the whole workspace or one relative file path.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": { "type": ["string", "null"] },
                    "staged": { "type": "boolean" }
                },
                "required": ["path", "staged"],
                "additionalProperties": false
            },
            "strict": true
        }),
        json!({
            "type": "function",
            "name": "run_command",
            "description": "Run a bounded development command directly inside the workspace without a shell. Use this for tests, builds, formatting, Git inspection, or rg searches.",
            "parameters": {
                "type": "object",
                "properties": {
                    "program": { "type": "string" },
                    "args": { "type": "array", "items": { "type": "string" } },
                    "workdir": { "type": ["string", "null"] },
                    "timeout_seconds": { "type": "integer", "minimum": 1, "maximum": 120 }
                },
                "required": ["program", "args", "workdir", "timeout_seconds"],
                "additionalProperties": false
            },
            "strict": true
        }),
    ];
    tools.retain(|tool| {
        tool.get("name")
            .and_then(Value::as_str)
            .is_some_and(|name| profile.allows_tool(name))
    });
    if allow_delegate && profile == AgentProfile::Root {
        tools.push(json!({
            "type": "function",
            "name": "delegate_task",
            "description": "Delegate one bounded specialist task to an independent Traceframe subagent. Choose scout or reviewer for read-only investigation and worker only when repository mutation or commands are required. The host enforces the profile; the child inherits this provider, model, branch, and authorized workspace and cannot delegate again.",
            "parameters": {
                "type": "object",
                "properties": {
                    "name": { "type": "string", "minLength": 1, "maxLength": 48 },
                    "role": { "type": "string", "minLength": 1, "maxLength": 48 },
                    "profile": { "type": "string", "enum": ["scout", "reviewer", "worker"] },
                    "task": { "type": "string", "minLength": 1, "maxLength": 2000 }
                },
                "required": ["name", "role", "profile", "task"],
                "additionalProperties": false
            },
            "strict": true
        }));
    }
    tools
}

fn required_string<'a>(arguments: &'a Value, name: &str) -> Result<&'a str, String> {
    arguments
        .get(name)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("Tool argument '{name}' must be a string"))
}

fn tool_workdir(workspace: &Path, workdir: Option<&str>) -> Result<PathBuf, String> {
    let Some(workdir) = workdir.filter(|value| !value.trim().is_empty()) else {
        return Ok(workspace.to_path_buf());
    };
    let relative = safe_relative_path(workdir)?;
    let directory = workspace
        .join(relative)
        .canonicalize()
        .map_err(|error| format!("Command working directory is unavailable: {error}"))?;
    if !directory.starts_with(workspace) || !directory.is_dir() {
        return Err("Command working directory is outside the authorized workspace".into());
    }
    Ok(directory)
}

fn command_allowed(program: &str) -> bool {
    matches!(
        program,
        "cargo"
            | "npm"
            | "pnpm"
            | "yarn"
            | "bun"
            | "node"
            | "deno"
            | "git"
            | "rg"
            | "grep"
            | "make"
            | "go"
            | "rustc"
            | "swift"
            | "python"
            | "python3"
            | "pytest"
    )
}

fn diff_changed_range(diff: &str) -> Option<(usize, usize)> {
    let hunk = diff.lines().find(|line| line.starts_with("@@ "))?;
    let next = hunk.split_whitespace().find(|part| part.starts_with('+'))?;
    let (start, count) = next[1..].split_once(',').unwrap_or((&next[1..], "1"));
    let start = start.parse::<usize>().ok()?.max(1);
    let count = count.parse::<usize>().ok()?.max(1);
    Some((start, start.saturating_add(count - 1)))
}

fn command_file_states(workspace: &Path) -> HashMap<String, CommandFileState> {
    let Ok(snapshot) = git_snapshot_at(workspace) else {
        return HashMap::new();
    };
    snapshot
        .files
        .into_iter()
        .map(|file| {
            let staged = git_diff_at(workspace, true, Some(file.path.clone()))
                .unwrap_or_else(|error| format!("staged diff error: {error}"));
            let working = git_diff_at(workspace, false, Some(file.path.clone()))
                .unwrap_or_else(|error| format!("working diff error: {error}"));
            let preview = if staged.trim().is_empty() && working.trim().is_empty() {
                read_workspace_file_at(workspace, file.path.clone())
                    .map(|file| file.content)
                    .unwrap_or_default()
            } else {
                String::new()
            };
            let metadata = (staged.trim().is_empty() && working.trim().is_empty())
                .then(|| {
                    safe_relative_path(&file.path)
                        .ok()
                        .and_then(|path| std::fs::metadata(workspace.join(path)).ok())
                        .map(|metadata| {
                            let modified = metadata
                                .modified()
                                .ok()
                                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                                .map(|duration| duration.as_nanos())
                                .unwrap_or_default();
                            (metadata.len(), modified)
                        })
                })
                .flatten();
            let range = diff_changed_range(&working)
                .or_else(|| diff_changed_range(&staged))
                .unwrap_or_else(|| {
                    let lines = preview.lines().count().max(1);
                    (1, lines)
                });
            let mut hasher = std::collections::hash_map::DefaultHasher::new();
            file.index_status.hash(&mut hasher);
            file.worktree_status.hash(&mut hasher);
            staged.hash(&mut hasher);
            working.hash(&mut hasher);
            preview.hash(&mut hasher);
            metadata.hash(&mut hasher);
            (
                file.path,
                CommandFileState {
                    fingerprint: hasher.finish(),
                    start_line: range.0,
                    end_line: range.1,
                },
            )
        })
        .collect()
}

fn changed_command_files(
    before: &HashMap<String, CommandFileState>,
    after: &HashMap<String, CommandFileState>,
) -> Vec<ChangedFile> {
    let mut changes = after
        .iter()
        .filter(|(path, state)| {
            before
                .get(*path)
                .is_none_or(|previous| previous.fingerprint != state.fingerprint)
        })
        .map(|(path, state)| ChangedFile {
            path: path.clone(),
            start_line: state.start_line,
            end_line: state.end_line,
        })
        .collect::<Vec<_>>();
    changes.extend(
        before
            .iter()
            .filter(|(path, _)| !after.contains_key(*path))
            .map(|(path, state)| ChangedFile {
                path: path.clone(),
                start_line: state.start_line,
                end_line: state.end_line,
            }),
    );
    changes.sort_by(|left, right| left.path.cmp(&right.path));
    changes
}

async fn read_bounded_output<R>(mut reader: R, limit: usize) -> std::io::Result<(Vec<u8>, bool)>
where
    R: AsyncRead + Unpin,
{
    let mut retained = Vec::with_capacity(limit.min(8 * 1024));
    let mut buffer = [0u8; 8 * 1024];
    let mut truncated = false;
    loop {
        let count = reader.read(&mut buffer).await?;
        if count == 0 {
            break;
        }
        let remaining = limit.saturating_sub(retained.len());
        if remaining > 0 {
            retained.extend_from_slice(&buffer[..count.min(remaining)]);
        }
        truncated |= count > remaining;
    }
    Ok((retained, truncated))
}

async fn run_bounded_command(
    workspace: &Path,
    program: &str,
    args: &[String],
    workdir: Option<&str>,
    timeout: Duration,
    cancellation: &AtomicBool,
) -> Result<ToolExecution, String> {
    if !command_allowed(program) {
        return Err(format!(
            "Command '{program}' is not in the Traceframe development allowlist"
        ));
    }
    if args.len() > MAX_COMMAND_ARGS || args.iter().any(|argument| argument.len() > 4_096) {
        return Err("Command arguments exceed the safety limit".into());
    }
    if args.iter().any(|argument| argument.as_bytes().contains(&0)) {
        return Err("Command arguments cannot contain NUL bytes".into());
    }
    let directory = tool_workdir(workspace, workdir)?;
    let files_before = command_file_states(workspace);
    let mut command = Command::new(program);
    command
        .args(args)
        .current_dir(directory)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command
        .spawn()
        .map_err(|error| format!("Command could not start: {error}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Command output is unavailable".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Command error output is unavailable".to_string())?;
    let stdout_task =
        tokio::spawn(async move { read_bounded_output(stdout, MAX_COMMAND_OUTPUT_BYTES).await });
    let stderr_task =
        tokio::spawn(async move { read_bounded_output(stderr, MAX_ERROR_BYTES).await });
    let started = Instant::now();
    let mut stop_reason = None;
    let status = loop {
        if cancellation.load(Ordering::SeqCst) {
            terminate_child(&mut child).await?;
            stop_reason = Some("Run cancelled by user".to_string());
            break None;
        }
        if started.elapsed() >= timeout {
            terminate_child(&mut child).await?;
            stop_reason = Some(format!(
                "Command timed out after {} seconds",
                timeout.as_secs()
            ));
            break None;
        }
        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("Command status could not be read: {error}"))?
        {
            break Some(status);
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    let stdout = stdout_task
        .await
        .map_err(|error| format!("Command output reader stopped: {error}"))?
        .map_err(|error| format!("Command output could not be read: {error}"))?;
    let stderr = stderr_task
        .await
        .map_err(|error| format!("Command error reader stopped: {error}"))?
        .map_err(|error| format!("Command error output could not be read: {error}"))?;
    let (stdout, stdout_truncated) = stdout;
    let (stderr, stderr_truncated) = stderr;
    let files_after = command_file_states(workspace);
    let success = status.as_ref().is_some_and(|status| status.success());
    Ok(ToolExecution {
        output: json!({
            "exitCode": status.as_ref().and_then(|status| status.code()),
            "success": success,
            "error": stop_reason,
            "stdout": String::from_utf8_lossy(&stdout),
            "stderr": String::from_utf8_lossy(&stderr),
            "stdoutTruncated": stdout_truncated,
            "stderrTruncated": stderr_truncated,
        })
        .to_string(),
        changed_files: changed_command_files(&files_before, &files_after),
        ok: success,
    })
}

async fn execute_tool(
    name: &str,
    raw_arguments: &str,
    workspace: &Path,
    access: &WorkspaceAccess,
    cancellation: &AtomicBool,
) -> Result<ToolExecution, String> {
    if cancellation.load(Ordering::SeqCst) {
        return Err("Run cancelled by user".into());
    }
    let arguments: Value = serde_json::from_str(raw_arguments)
        .map_err(|error| format!("Tool arguments are invalid JSON: {error}"))?;
    match name {
        "list_files" => {
            let query = arguments
                .get("query")
                .and_then(Value::as_str)
                .map(str::to_lowercase);
            let mut value = serde_json::to_value(workspace_tree_at(workspace)?)
                .map_err(|error| format!("Workspace tree could not be encoded: {error}"))?;
            if let (Some(query), Some(entries)) = (
                query.filter(|query| !query.is_empty()),
                value.get_mut("entries").and_then(Value::as_array_mut),
            ) {
                entries.retain(|entry| {
                    entry
                        .get("path")
                        .and_then(Value::as_str)
                        .is_some_and(|path| path.to_lowercase().contains(&query))
                });
            }
            Ok(ToolExecution {
                output: value.to_string(),
                changed_files: Vec::new(),
                ok: true,
            })
        }
        "read_file" => {
            let path = required_string(&arguments, "path")?.to_owned();
            let file = read_workspace_file_at(workspace, path)?;
            Ok(ToolExecution {
                output: serde_json::to_string(&file)
                    .map_err(|error| format!("Workspace file could not be encoded: {error}"))?,
                changed_files: Vec::new(),
                ok: true,
            })
        }
        "edit_file" => {
            let path = required_string(&arguments, "path")?.to_owned();
            let old_text = required_string(&arguments, "old_text")?;
            let new_text = required_string(&arguments, "new_text")?;
            let replace_all = arguments
                .get("replace_all")
                .and_then(Value::as_bool)
                .ok_or_else(|| "Tool argument 'replace_all' must be a boolean".to_string())?;
            if old_text.is_empty() {
                return Err("edit_file old_text cannot be empty".into());
            }
            let _write_guard = access
                .writes
                .lock()
                .map_err(|_| "Workspace write state is unavailable".to_string())?;
            if cancellation.load(Ordering::SeqCst) {
                return Err("Run cancelled by user".into());
            }
            let current = read_workspace_file_at(workspace, path.clone())?;
            if current.truncated {
                return Err("Truncated files cannot be edited".into());
            }
            let occurrences = current.content.matches(old_text).count();
            if occurrences == 0 {
                return Err("edit_file old_text was not found".into());
            }
            if occurrences > 1 && !replace_all {
                return Err(format!(
                    "edit_file old_text matched {occurrences} locations; provide more context or set replace_all"
                ));
            }
            let next = if replace_all {
                current.content.replace(old_text, new_text)
            } else {
                current.content.replacen(old_text, new_text, 1)
            };
            let (start_line, end_line) = changed_line_range(&current.content, &next);
            let saved = write_workspace_file_at(workspace, path.clone(), current.content, next)?;
            let changed_file = ChangedFile {
                path: saved.path.clone(),
                start_line,
                end_line,
            };
            Ok(ToolExecution {
                output: serde_json::to_string(&saved)
                    .map_err(|error| format!("Workspace file could not be encoded: {error}"))?,
                changed_files: vec![changed_file],
                ok: true,
            })
        }
        "write_file" => {
            let path = required_string(&arguments, "path")?.to_owned();
            let expected = required_string(&arguments, "expected_original_content")?.to_owned();
            let new_content = required_string(&arguments, "new_content")?.to_owned();
            let _write_guard = access
                .writes
                .lock()
                .map_err(|_| "Workspace write state is unavailable".to_string())?;
            if cancellation.load(Ordering::SeqCst) {
                return Err("Run cancelled by user".into());
            }
            let (start_line, end_line) = changed_line_range(&expected, &new_content);
            let saved = write_workspace_file_at(workspace, path.clone(), expected, new_content)?;
            let changed_file = ChangedFile {
                path: saved.path.clone(),
                start_line,
                end_line,
            };
            Ok(ToolExecution {
                output: serde_json::to_string(&saved)
                    .map_err(|error| format!("Workspace file could not be encoded: {error}"))?,
                changed_files: vec![changed_file],
                ok: true,
            })
        }
        "create_file" => {
            let path = required_string(&arguments, "path")?.to_owned();
            let content = required_string(&arguments, "content")?.to_owned();
            let _write_guard = access
                .writes
                .lock()
                .map_err(|_| "Workspace write state is unavailable".to_string())?;
            if cancellation.load(Ordering::SeqCst) {
                return Err("Run cancelled by user".into());
            }
            let saved = create_workspace_file_at(workspace, path.clone(), content)?;
            let changed_file = ChangedFile {
                path: saved.path.clone(),
                start_line: 1,
                end_line: saved.content.split('\n').count().max(1),
            };
            Ok(ToolExecution {
                output: serde_json::to_string(&saved)
                    .map_err(|error| format!("Workspace file could not be encoded: {error}"))?,
                changed_files: vec![changed_file],
                ok: true,
            })
        }
        "git_status" => Ok(ToolExecution {
            output: serde_json::to_string(&git_snapshot_at(workspace)?)
                .map_err(|error| format!("Git status could not be encoded: {error}"))?,
            changed_files: Vec::new(),
            ok: true,
        }),
        "git_diff" => {
            let path = arguments
                .get("path")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let staged = arguments
                .get("staged")
                .and_then(Value::as_bool)
                .ok_or_else(|| "Tool argument 'staged' must be a boolean".to_string())?;
            Ok(ToolExecution {
                output: git_diff_at(workspace, staged, path)?,
                changed_files: Vec::new(),
                ok: true,
            })
        }
        "run_command" => {
            let program = required_string(&arguments, "program")?;
            let args = arguments
                .get("args")
                .and_then(Value::as_array)
                .ok_or_else(|| "Tool argument 'args' must be an array".to_string())?
                .iter()
                .map(|argument| {
                    argument
                        .as_str()
                        .map(str::to_owned)
                        .ok_or_else(|| "Command arguments must be strings".to_string())
                })
                .collect::<Result<Vec<_>, _>>()?;
            let workdir = arguments.get("workdir").and_then(Value::as_str);
            let timeout_seconds = arguments
                .get("timeout_seconds")
                .and_then(Value::as_u64)
                .unwrap_or(DEFAULT_COMMAND_TIMEOUT.as_secs())
                .clamp(1, DEFAULT_COMMAND_TIMEOUT.as_secs());
            run_bounded_command(
                workspace,
                program,
                &args,
                workdir,
                Duration::from_secs(timeout_seconds),
                cancellation,
            )
            .await
        }
        _ => Err(format!("Unknown Traceframe tool '{name}'")),
    }
}

fn response_output_text(items: &[Value]) -> String {
    items
        .iter()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("message"))
        .filter_map(|item| item.get("content").and_then(Value::as_array))
        .flatten()
        .filter(|content| content.get("type").and_then(Value::as_str) == Some("output_text"))
        .filter_map(|content| content.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("")
}

fn response_failure(value: &Value) -> Option<String> {
    match value.get("type").and_then(Value::as_str) {
        Some("response.failed" | "response.incomplete" | "error") => Some(
            value
                .pointer("/response/error/message")
                .or_else(|| value.pointer("/error/message"))
                .or_else(|| value.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("Responses API stream ended with an error")
                .to_owned(),
        ),
        _ => None,
    }
}

async fn send_responses_request(
    provider: &ProviderConfig,
    instructions: &str,
    input: &[Value],
    allow_tools: bool,
    profile: AgentProfile,
    allow_delegate: bool,
) -> Result<reqwest::Response, String> {
    if provider.model.trim().is_empty() {
        return Err("Responses provider model is required".into());
    }
    let url = provider_api_url(provider, "responses")?;
    let mut body = json!({
        "model": provider.model,
        "instructions": instructions,
        "input": input,
        "stream": true,
        "store": false,
        "include": ["reasoning.encrypted_content"]
    });
    if allow_tools {
        body["tools"] = json!(tool_definitions(profile, allow_delegate));
        body["tool_choice"] = json!("auto");
        body["parallel_tool_calls"] = json!(false);
    }
    authorize(client()?.post(url), provider)
        .json(&body)
        .send()
        .await
        .map_err(|error| format!("Responses request failed: {error}"))
}

async fn stream_responses_round(
    response: reqwest::Response,
    request: &RuntimeRequest,
    on_event: &Channel<StreamEvent>,
    store: &AppStore,
    cancellation: &AtomicBool,
    sequence: &mut u64,
    agent: &AgentContext,
) -> Result<Option<ResponsesRound>, String> {
    let mut stream = response.bytes_stream();
    let mut buffer = Vec::new();
    let mut total_bytes = 0usize;
    let mut text = String::new();
    let mut item_events = Vec::new();
    let mut completed_output = None;
    let mut usage = Value::Null;
    let mut completed = false;

    loop {
        if cancellation.load(Ordering::SeqCst) {
            emit_agent(
                on_event,
                store,
                request,
                sequence,
                "run.cancelled",
                json!({ "reason": "user" }),
                agent,
            )?;
            return Ok(None);
        }
        let chunk = match tokio::time::timeout(Duration::from_millis(150), stream.next()).await {
            Err(_) => continue,
            Ok(None) => break,
            Ok(Some(chunk)) => {
                chunk.map_err(|error| format!("Responses stream failed: {error}"))?
            }
        };
        total_bytes = total_bytes.saturating_add(chunk.len());
        if total_bytes > MAX_STREAM_BYTES {
            return Err("Responses stream exceeded the 8 MiB safety limit".into());
        }
        buffer.extend_from_slice(&chunk);
        while let Some(block) = take_sse_block(&mut buffer) {
            let Some(data) = parse_sse_data(&block) else {
                continue;
            };
            if data.trim() == "[DONE]" {
                completed = true;
                break;
            }
            let value: Value = serde_json::from_str(&data)
                .map_err(|error| format!("Responses stream returned invalid JSON: {error}"))?;
            if let Some(error) = response_failure(&value) {
                return Err(error);
            }
            match value.get("type").and_then(Value::as_str) {
                Some("response.output_text.delta") => {
                    if let Some(delta) = value.get("delta").and_then(Value::as_str) {
                        text.push_str(delta);
                        emit_agent(
                            on_event,
                            store,
                            request,
                            sequence,
                            "model.delta",
                            json!({ "text": delta }),
                            agent,
                        )?;
                    }
                }
                Some("response.output_item.done") => {
                    if let Some(item) = value.get("item") {
                        item_events.push(item.clone());
                    }
                }
                Some("response.completed") => {
                    if let Some(output) =
                        value.pointer("/response/output").and_then(Value::as_array)
                    {
                        completed_output = Some(output.clone());
                    }
                    if let Some(next_usage) = value.pointer("/response/usage") {
                        usage = next_usage.clone();
                    }
                    completed = true;
                }
                _ => {}
            }
        }
        if completed {
            break;
        }
    }
    if !completed {
        return Err("Responses stream ended before a terminal event".into());
    }
    let output_items = completed_output.unwrap_or(item_events);
    if text.is_empty() {
        text = response_output_text(&output_items);
    }
    let tool_calls = output_items
        .iter()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("function_call"))
        .map(|item| {
            Ok(ToolCall {
                call_id: item
                    .get("call_id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "Responses function call is missing call_id".to_string())?
                    .to_owned(),
                name: item
                    .get("name")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "Responses function call is missing name".to_string())?
                    .to_owned(),
                arguments: item
                    .get("arguments")
                    .and_then(Value::as_str)
                    .unwrap_or("{}")
                    .to_owned(),
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(Some(ResponsesRound {
        text,
        output_items,
        tool_calls,
        usage,
    }))
}

async fn run_responses_agent(
    request: &RuntimeRequest,
    workspace: &Path,
    instructions: &str,
    mut input: Vec<Value>,
    on_event: &Channel<StreamEvent>,
    store: &AppStore,
    access: &WorkspaceAccess,
    cancellation: &AtomicBool,
    sequence: &mut u64,
    agent: &AgentContext,
    budget: &mut AgentBudget,
) -> Result<Option<AgentOutcome>, String> {
    let mut usage_rounds = Vec::new();
    let max_rounds = if agent.allow_delegate {
        MAX_TOOL_ROUNDS
    } else {
        MAX_CHILD_TOOL_ROUNDS
    };
    for round_index in 0..=max_rounds {
        let allow_tools = round_index < max_rounds;
        if cancellation.load(Ordering::SeqCst) {
            emit_agent(
                on_event,
                store,
                request,
                sequence,
                "run.cancelled",
                json!({ "reason": "user" }),
                agent,
            )?;
            return Ok(None);
        }
        emit_agent(
            on_event,
            store,
            request,
            sequence,
            "model.requested",
            json!({
                "endpoint": request.provider.endpoint,
                "model": request.provider.model,
                "round": round_index + 1,
                "toolsEnabled": allow_tools,
            }),
            agent,
        )?;
        let round_instructions = if allow_tools {
            instructions.to_owned()
        } else {
            format!(
                "{instructions}\n\nThe Traceframe tool budget is exhausted. Do not request more tools. Return the best final answer supported by the tool results already present, and state any incomplete work explicitly."
            )
        };
        let response = {
            let request_future = send_responses_request(
                &request.provider,
                &round_instructions,
                &input,
                allow_tools,
                agent.profile,
                allow_tools && agent.allow_delegate,
            );
            tokio::pin!(request_future);
            loop {
                match tokio::time::timeout(Duration::from_millis(100), request_future.as_mut())
                    .await
                {
                    Ok(result) => break result?,
                    Err(_) if cancellation.load(Ordering::SeqCst) => {
                        emit_agent(
                            on_event,
                            store,
                            request,
                            sequence,
                            "run.cancelled",
                            json!({ "reason": "user" }),
                            agent,
                        )?;
                        return Ok(None);
                    }
                    Err(_) => continue,
                }
            }
        };
        if !response.status().is_success() {
            return Err(bounded_error(response).await);
        }
        let Some(round) = stream_responses_round(
            response,
            request,
            on_event,
            store,
            cancellation,
            sequence,
            agent,
        )
        .await?
        else {
            return Ok(None);
        };
        usage_rounds.push(round.usage.clone());
        if round.tool_calls.is_empty() {
            if round.text.trim().is_empty() {
                return Err("Responses agent completed without text or tool calls".into());
            }
            return Ok(Some(AgentOutcome {
                text: round.text,
                rounds: round_index + 1,
                usage: usage_rounds,
            }));
        }
        if !allow_tools {
            return Err(
                "Responses provider requested tools after the tool budget was exhausted".into(),
            );
        }

        input.extend(round.output_items);
        for call in round.tool_calls {
            if cancellation.load(Ordering::SeqCst) {
                emit_agent(
                    on_event,
                    store,
                    request,
                    sequence,
                    "run.cancelled",
                    json!({ "reason": "user" }),
                    agent,
                )?;
                return Ok(None);
            }
            emit_agent(
                on_event,
                store,
                request,
                sequence,
                "tool.started",
                json!({
                    "item": {
                        "type": "function_call",
                        "callId": call.call_id,
                        "name": call.name,
                        "arguments": call.arguments,
                    }
                }),
                agent,
            )?;
            let started = Instant::now();
            if !agent.profile.allows_tool(&call.name)
                || (call.name == "delegate_task" && !agent.allow_delegate)
            {
                let output = format!(
                    "The {} agent profile is not permitted to use {}",
                    agent.profile.as_str(),
                    call.name
                );
                emit_agent(
                    on_event,
                    store,
                    request,
                    sequence,
                    "tool.failed",
                    json!({
                        "item": {
                            "type": "function_call",
                            "callId": call.call_id,
                            "name": call.name,
                        },
                        "ok": false,
                        "durationMs": started.elapsed().as_millis(),
                        "output": output,
                    }),
                    agent,
                )?;
                input.push(json!({
                    "type": "function_call_output",
                    "call_id": call.call_id,
                    "output": output,
                }));
                continue;
            }
            let execution = if call.name == "delegate_task" {
                let result = (|| -> Result<(String, String, AgentProfile, String), String> {
                    if !agent.allow_delegate {
                        return Err("Subagents cannot delegate another task".into());
                    }
                    if budget.delegated >= MAX_DELEGATED_AGENTS {
                        return Err(format!(
                            "The run reached its {MAX_DELEGATED_AGENTS}-subagent budget"
                        ));
                    }
                    let arguments: Value = serde_json::from_str(&call.arguments)
                        .map_err(|error| format!("delegate_task arguments are invalid: {error}"))?;
                    let name = required_string(&arguments, "name")?.trim();
                    let role = required_string(&arguments, "role")?.trim();
                    let profile = AgentProfile::parse(required_string(&arguments, "profile")?)?;
                    let task = required_string(&arguments, "task")?.trim();
                    if name.is_empty() || role.is_empty() || task.is_empty() {
                        return Err("delegate_task name, role, and task are required".into());
                    }
                    if name.chars().count() > 48
                        || role.chars().count() > 48
                        || task.chars().count() > MAX_MESSAGE_CHARS
                    {
                        return Err("delegate_task arguments exceed their size limit".into());
                    }
                    Ok((name.to_owned(), role.to_owned(), profile, task.to_owned()))
                })();
                match result {
                    Err(error) => ToolExecution {
                        output: json!({ "error": error }).to_string(),
                        changed_files: Vec::new(),
                        ok: false,
                    },
                    Ok((name, role, profile, task)) => {
                        budget.delegated += 1;
                        let child = AgentContext {
                            id: format!("{}-agent-{}", request.run_id, budget.delegated),
                            parent_id: Some(agent.id.clone()),
                            name,
                            role,
                            task,
                            allow_delegate: false,
                            profile,
                        };
                        emit(
                            on_event,
                            store,
                            request,
                            sequence,
                            "agent.started",
                            json!({
                                "agentId": child.id,
                                "parentAgentId": agent.id,
                                "name": child.name,
                                "role": child.role,
                                "profile": child.profile.as_str(),
                                "task": child.task,
                                "model": request.provider.model,
                                "status": "working",
                                "delegateCallId": call.call_id,
                            }),
                        )?;
                        let child_instructions = specialist_instructions(request, &child);
                        let child_input = vec![json!({
                            "role": "user",
                            "content": child.task,
                        })];
                        match Box::pin(run_responses_agent(
                            request,
                            workspace,
                            &child_instructions,
                            child_input,
                            on_event,
                            store,
                            access,
                            cancellation,
                            sequence,
                            &child,
                            budget,
                        ))
                        .await
                        {
                            Ok(None) => {
                                emit(
                                    on_event,
                                    store,
                                    request,
                                    sequence,
                                    "agent.completed",
                                    json!({
                                        "agentId": child.id,
                                        "parentAgentId": agent.id,
                                        "name": child.name,
                                        "role": child.role,
                                        "profile": child.profile.as_str(),
                                        "task": child.task,
                                        "model": request.provider.model,
                                        "status": "cancelled",
                                        "delegateCallId": call.call_id,
                                    }),
                                )?;
                                return Ok(None);
                            }
                            Ok(Some(outcome)) => {
                                emit(
                                    on_event,
                                    store,
                                    request,
                                    sequence,
                                    "agent.completed",
                                    json!({
                                        "agentId": child.id,
                                        "parentAgentId": agent.id,
                                        "name": child.name,
                                        "role": child.role,
                                        "profile": child.profile.as_str(),
                                        "task": child.task,
                                        "model": request.provider.model,
                                        "status": "completed",
                                        "delegateCallId": call.call_id,
                                        "result": truncate_chars(&outcome.text, MAX_SUMMARY_CHARS),
                                        "rounds": outcome.rounds,
                                        "usage": outcome.usage,
                                    }),
                                )?;
                                ToolExecution {
                                    output: json!({
                                        "agentId": child.id,
                                        "status": "completed",
                                        "result": outcome.text,
                                    })
                                    .to_string(),
                                    changed_files: Vec::new(),
                                    ok: true,
                                }
                            }
                            Err(error) => {
                                emit(
                                    on_event,
                                    store,
                                    request,
                                    sequence,
                                    "agent.completed",
                                    json!({
                                        "agentId": child.id,
                                        "parentAgentId": agent.id,
                                        "name": child.name,
                                        "role": child.role,
                                        "profile": child.profile.as_str(),
                                        "task": child.task,
                                        "model": request.provider.model,
                                        "status": "failed",
                                        "delegateCallId": call.call_id,
                                        "error": error,
                                    }),
                                )?;
                                ToolExecution {
                                    output: json!({
                                        "agentId": child.id,
                                        "status": "failed",
                                        "error": error,
                                    })
                                    .to_string(),
                                    changed_files: Vec::new(),
                                    ok: false,
                                }
                            }
                        }
                    }
                }
            } else {
                match execute_tool(&call.name, &call.arguments, workspace, access, cancellation)
                    .await
                {
                    Ok(execution) => execution,
                    Err(error) => ToolExecution {
                        output: json!({ "error": error }).to_string(),
                        changed_files: Vec::new(),
                        ok: false,
                    },
                }
            };
            for change in &execution.changed_files {
                emit_agent(
                    on_event,
                    store,
                    request,
                    sequence,
                    "file.changed",
                    json!({
                        "path": change.path,
                        "tool": call.name,
                        "startLine": change.start_line,
                        "endLine": change.end_line,
                    }),
                    agent,
                )?;
            }
            if cancellation.load(Ordering::SeqCst) {
                emit_agent(
                    on_event,
                    store,
                    request,
                    sequence,
                    "tool.failed",
                    json!({
                        "item": {
                            "type": "function_call",
                            "callId": call.call_id,
                            "name": call.name,
                        },
                        "ok": false,
                        "durationMs": started.elapsed().as_millis(),
                        "output": "Run cancelled by user",
                    }),
                    agent,
                )?;
                emit_agent(
                    on_event,
                    store,
                    request,
                    sequence,
                    "run.cancelled",
                    json!({ "reason": "user" }),
                    agent,
                )?;
                return Ok(None);
            }
            emit_agent(
                on_event,
                store,
                request,
                sequence,
                if execution.ok {
                    "tool.completed"
                } else {
                    "tool.failed"
                },
                json!({
                    "item": {
                        "type": "function_call",
                        "callId": call.call_id,
                        "name": call.name,
                    },
                    "ok": execution.ok,
                    "durationMs": started.elapsed().as_millis(),
                    "output": truncate_chars(&execution.output, 2_000),
                }),
                agent,
            )?;
            input.push(json!({
                "type": "function_call_output",
                "call_id": call.call_id,
                "output": model_tool_output(&execution.output),
            }));
        }
    }
    Err(format!(
        "Responses agent did not return a final answer after {max_rounds} tool rounds"
    ))
}

#[tauri::command]
pub async fn runtime_start(
    mut request: RuntimeRequest,
    on_event: Channel<StreamEvent>,
    control: State<'_, RuntimeControl>,
    store: State<'_, AppStore>,
    access: State<'_, WorkspaceAccess>,
) -> Result<(), String> {
    if request.prompt.trim().is_empty() {
        return Err("Run prompt cannot be empty".into());
    }
    let workspace = access.resolve(&request.workspace_path)?;
    request.workspace_path = workspace.to_string_lossy().to_string();
    let actual_branch = git_snapshot_at(&workspace)?.branch;
    if actual_branch != request.branch {
        return Err(format!(
            "Run scope is stale: session expects branch '{}' but '{}' is checked out",
            request.branch, actual_branch
        ));
    }
    let cancellation = control.register(&request.run_id)?;
    let _registration = RunRegistration {
        control: &control,
        run_id: request.run_id.clone(),
        cancellation: cancellation.clone(),
    };

    let mut sequence = 0;
    emit(
        &on_event,
        &store,
        &request,
        &mut sequence,
        "run.created",
        json!({
            "providerId": request.provider.id,
            "provider": request.provider.name,
            "model": request.provider.model,
            "workspace": request.workspace_path,
            "branch": request.branch,
        }),
    )?;
    let (summary, context) = store.context_messages(&request.session_id)?;
    let memories = store.context_memories(&request.session_id, &request.workspace_path)?;

    if matches!(
        request.provider.adapter.as_str(),
        "cc-switch-responses" | "openai-responses"
    ) {
        let instructions = agent_instructions(&request, &summary, &memories);
        let input = responses_input(&context, &request.prompt);
        let root_agent = AgentContext {
            id: "root".into(),
            parent_id: None,
            name: request.provider.name.clone(),
            role: "Orchestrator".into(),
            task: request.prompt.clone(),
            allow_delegate: true,
            profile: AgentProfile::Root,
        };
        let mut budget = AgentBudget::default();
        let result = run_responses_agent(
            &request,
            &workspace,
            &instructions,
            input,
            &on_event,
            &store,
            &access,
            &cancellation,
            &mut sequence,
            &root_agent,
            &mut budget,
        )
        .await;
        return match result {
            Ok(Some(outcome)) => {
                store.append_message_record(NewMessage {
                    session_id: request.session_id.clone(),
                    author: request.provider.name.clone(),
                    role: "agent".into(),
                    body: outcome.text,
                    meta: format!("{} · Traceframe agent", request.provider.model),
                })?;
                emit(
                    &on_event,
                    &store,
                    &request,
                    &mut sequence,
                    "run.completed",
                    json!({
                        "adapter": request.provider.adapter,
                        "rounds": outcome.rounds,
                        "usage": outcome.usage,
                        "delegatedAgents": budget.delegated,
                    }),
                )?;
                Ok(())
            }
            Ok(None) => Ok(()),
            Err(error) => {
                let _ = emit(
                    &on_event,
                    &store,
                    &request,
                    &mut sequence,
                    "run.failed",
                    json!({ "error": error }),
                );
                Err(error)
            }
        };
    }

    emit(
        &on_event,
        &store,
        &request,
        &mut sequence,
        "model.requested",
        json!({
            "endpoint": request.provider.endpoint,
            "model": request.provider.model,
            "round": 1,
        }),
    )?;

    let system = format!(
        "You are the model connected to Traceframe, a transparent desktop coding workspace. The selected repository is {} on branch {}. This adapter currently provides conversation and trace streaming only: do not claim you read, changed, tested, or executed files. You cannot create or update durable Memory records, so never claim information was saved for future sessions; ask the user to save it explicitly in the Memory panel. Give concrete guidance and clearly identify actions that still need a tool-enabled agent. Durable session summary:\n{}\n\nScoped durable memories (the current explicit request wins if any memory conflicts):\n{}",
        request.workspace_path,
        request.branch,
        summary_for_prompt(&summary, &request.prompt),
        format_memories(&memories)
    );
    let history = without_current_prompt(&context, &request.prompt);
    let is_anthropic = request.provider.adapter == "anthropic";
    let response = if is_anthropic {
        let mut messages = history
            .iter()
            .map(|message| {
                let content = truncate_chars(&message.body, MAX_MESSAGE_CHARS);
                json!({
                    "role": if message.role == "agent" { "assistant" } else { "user" },
                    "content": if message.role == "system" {
                        format!("Traceframe runtime note: {content}")
                    } else {
                        content
                    },
                })
            })
            .collect::<Vec<_>>();
        messages.push(json!({ "role": "user", "content": request.prompt.trim() }));
        await_cancellable_response(
            send_anthropic_request(&request.provider, &system, &messages),
            &cancellation,
        )
        .await
    } else if request.provider.adapter == "openai-chat" {
        let mut messages = vec![json!({ "role": "system", "content": system })];
        messages.extend(history.iter().map(|message| {
            json!({
                "role": if message.role == "agent" { "assistant" } else { message.role.as_str() },
                "content": truncate_chars(&message.body, MAX_MESSAGE_CHARS),
            })
        }));
        messages.push(json!({ "role": "user", "content": request.prompt.trim() }));
        await_cancellable_response(
            async {
                let url = api_url(&request.provider.endpoint, "chat/completions")?;
                authorize(client()?.post(url), &request.provider)
                    .json(&json!({
                        "model": request.provider.model,
                        "messages": messages,
                        "stream": true,
                        "stream_options": { "include_usage": true }
                    }))
                    .send()
                    .await
                    .map_err(|error| format!("Model request failed: {error}"))
            },
            &cancellation,
        )
        .await
    } else {
        Err(format!(
            "Runtime adapter '{}' is not supported",
            request.provider.adapter
        ))
    };
    let response = match response {
        Ok(Some(response)) => response,
        Ok(None) => {
            emit(
                &on_event,
                &store,
                &request,
                &mut sequence,
                "run.cancelled",
                json!({ "reason": "user" }),
            )?;
            return Ok(());
        }
        Err(error) => {
            emit_run_failed(&on_event, &store, &request, &mut sequence, &error);
            return Err(error);
        }
    };

    if !response.status().is_success() {
        let error = bounded_error(response).await;
        let _ = emit(
            &on_event,
            &store,
            &request,
            &mut sequence,
            "run.failed",
            json!({ "error": error }),
        );
        return Err(error);
    }

    let mut stream = response.bytes_stream();
    let mut buffer = Vec::new();
    let mut total_bytes = 0usize;
    let mut output = String::new();
    let mut usage = Value::Null;
    let mut done = false;

    loop {
        if cancellation.load(Ordering::SeqCst) {
            emit(
                &on_event,
                &store,
                &request,
                &mut sequence,
                "run.cancelled",
                json!({ "reason": "user" }),
            )?;
            return Ok(());
        }
        let chunk = match tokio::time::timeout(Duration::from_millis(150), stream.next()).await {
            Err(_) => continue,
            Ok(None) => break,
            Ok(Some(Ok(chunk))) => chunk,
            Ok(Some(Err(error))) => {
                let error = format!("Model stream failed: {error}");
                emit_run_failed(&on_event, &store, &request, &mut sequence, &error);
                return Err(error);
            }
        };
        total_bytes = total_bytes.saturating_add(chunk.len());
        if total_bytes > MAX_STREAM_BYTES {
            let error = "Model stream exceeded the 8 MiB safety limit".to_string();
            emit_run_failed(&on_event, &store, &request, &mut sequence, &error);
            return Err(error);
        }
        buffer.extend_from_slice(&chunk);
        while let Some(block) = take_sse_block(&mut buffer) {
            let Some(data) = parse_sse_data(&block) else {
                continue;
            };
            if data.trim() == "[DONE]" {
                done = true;
                break;
            }
            let value: Value = match serde_json::from_str(&data) {
                Ok(value) => value,
                Err(error) => {
                    let error = format!("Model stream returned invalid JSON: {error}");
                    emit_run_failed(&on_event, &store, &request, &mut sequence, &error);
                    return Err(error);
                }
            };
            if is_anthropic {
                if let Some(error) = anthropic_stream_error(&value) {
                    let error = format!("Anthropic stream failed: {error}");
                    emit_run_failed(&on_event, &store, &request, &mut sequence, &error);
                    return Err(error);
                }
                if let Some(delta) = anthropic_delta(&value) {
                    output.push_str(delta);
                    emit(
                        &on_event,
                        &store,
                        &request,
                        &mut sequence,
                        "model.delta",
                        json!({ "text": delta }),
                    )?;
                }
                if let Some(next_usage) = anthropic_usage(&value) {
                    merge_usage(&mut usage, next_usage);
                }
                if value.get("type").and_then(Value::as_str) == Some("message_stop") {
                    done = true;
                    break;
                }
            } else {
                if let Some(delta) = delta_from_chunk(&value) {
                    output.push_str(delta);
                    emit(
                        &on_event,
                        &store,
                        &request,
                        &mut sequence,
                        "model.delta",
                        json!({ "text": delta }),
                    )?;
                }
                if let Some(next_usage) = usage_from_chunk(&value) {
                    usage = next_usage;
                }
            }
        }
        if done {
            break;
        }
    }

    if !done {
        let error = if is_anthropic {
            "Anthropic stream ended before message_stop"
        } else {
            "Chat stream ended before [DONE]"
        }
        .to_string();
        emit_run_failed(&on_event, &store, &request, &mut sequence, &error);
        return Err(error);
    }

    if output.trim().is_empty() {
        let error = "Model stream completed without text output".to_string();
        emit_run_failed(&on_event, &store, &request, &mut sequence, &error);
        return Err(error);
    }

    if let Err(error) = store.append_message_record(NewMessage {
        session_id: request.session_id.clone(),
        author: request.provider.name.clone(),
        role: "agent".into(),
        body: output,
        meta: format!("{} · streamed", request.provider.model),
    }) {
        emit_run_failed(&on_event, &store, &request, &mut sequence, &error);
        return Err(error);
    }
    emit(
        &on_event,
        &store,
        &request,
        &mut sequence,
        "run.completed",
        json!({ "usage": usage }),
    )?;
    Ok(())
}

#[tauri::command]
pub fn runtime_cancel(run_id: String, control: State<'_, RuntimeControl>) -> Result<bool, String> {
    let runs = control
        .cancellations
        .lock()
        .map_err(|_| "Runtime cancellation state is unavailable".to_string())?;
    if let Some(cancellation) = runs.get(&run_id) {
        cancellation.store(true, Ordering::SeqCst);
        Ok(true)
    } else {
        Ok(false)
    }
}

#[cfg(test)]
mod tests {
    use super::{
        agent_instructions, anthropic_delta, anthropic_usage, api_url, await_cancellable_response,
        changed_command_files, changed_line_range, command_file_states, diff_changed_range,
        execute_tool, merge_usage, model_tool_output, parse_sse_data,
        provider_healthcheck_with_timeout, read_bounded_output, response_failure,
        response_output_text, responses_input, run_responses_agent, send_anthropic_request,
        send_responses_request, take_sse_block, terminate_child, tool_definitions, AgentBudget,
        AgentContext, AgentProfile, MemoryRecord, MessageRecord, ProviderConfig, RuntimeControl,
        RuntimeRequest, ANTHROPIC_MAX_TOKENS, MAX_ERROR_BYTES, MAX_MODEL_TOOL_OUTPUT_CHARS,
        MAX_TOOL_ROUNDS,
    };
    use crate::{store::AppStore, WorkspaceAccess};
    use serde_json::json;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::atomic::AtomicBool;
    use std::sync::{mpsc, Arc, Mutex};
    use std::thread;
    use std::time::{Duration, Instant};
    use tokio::io::AsyncWriteExt;
    use tokio::process::Command;

    fn provider(endpoint: String) -> ProviderConfig {
        ProviderConfig {
            id: "test".into(),
            name: "Test provider".into(),
            endpoint,
            model: "test-model".into(),
            adapter: "openai-chat".into(),
            api_key: "test-secret".into(),
        }
    }

    #[test]
    fn changed_line_range_tracks_replacements_insertions_and_deletions() {
        assert_eq!(
            changed_line_range("one\ntwo\nthree", "one\nchanged\nthree"),
            (2, 2)
        );
        assert_eq!(changed_line_range("one\nthree", "one\ntwo\nthree"), (2, 2));
        assert_eq!(changed_line_range("one\ntwo\nthree", "one\nthree"), (2, 2));
        assert_eq!(changed_line_range("one\ntwo", "one"), (1, 1));
        assert_eq!(changed_line_range("", "first\nsecond"), (1, 2));
    }

    #[test]
    fn command_change_detection_tracks_new_and_repeated_file_edits() {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("traceframe-command-change-{nonce}"));
        std::fs::create_dir_all(&root).unwrap();
        let git = |args: &[&str]| {
            assert!(std::process::Command::new("git")
                .arg("-C")
                .arg(&root)
                .args(args)
                .status()
                .unwrap()
                .success());
        };
        git(&["init", "-q"]);
        std::fs::write(root.join("tracked.txt"), "one\n").unwrap();
        git(&["add", "tracked.txt"]);
        git(&[
            "-c",
            "user.name=Traceframe Test",
            "-c",
            "user.email=traceframe@example.invalid",
            "commit",
            "-qm",
            "fixture",
        ]);
        let workspace = root.canonicalize().unwrap();
        let clean = command_file_states(&workspace);
        assert!(clean.is_empty());

        std::fs::write(workspace.join("tracked.txt"), "one\ntwo\n").unwrap();
        let first = command_file_states(&workspace);
        let first_changes = changed_command_files(&clean, &first);
        assert_eq!(first_changes.len(), 1);
        assert_eq!(first_changes[0].path, "tracked.txt");
        assert_eq!(
            diff_changed_range("@@ -1 +1,2 @@\n one\n+two"),
            Some((1, 2))
        );

        std::fs::write(workspace.join("tracked.txt"), "one\ntwo\nthree\n").unwrap();
        let second = command_file_states(&workspace);
        assert_eq!(changed_command_files(&first, &second).len(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn runtime_control_rejects_duplicate_active_run_ids() {
        let control = RuntimeControl::default();
        let first = control.register("run-1").unwrap();
        assert!(control
            .register("run-1")
            .unwrap_err()
            .contains("already active"));
        control.unregister("run-1", &Arc::new(AtomicBool::new(false)));
        assert!(control.register("run-1").is_err());
        control.unregister("run-1", &first);
        assert!(control.register("run-1").is_ok());
    }

    #[test]
    fn model_tool_output_is_bounded_with_an_actionable_notice() {
        assert_eq!(model_tool_output("small"), "small");
        let bounded = model_tool_output(&"x".repeat(MAX_MODEL_TOOL_OUTPUT_CHARS + 200));
        let value: serde_json::Value = serde_json::from_str(&bounded).unwrap();
        assert_eq!(value["truncated"], true);
        assert!(value["notice"]
            .as_str()
            .unwrap()
            .contains("Re-run a narrower"));
        assert!(
            value["output"].as_str().unwrap().chars().count() <= MAX_MODEL_TOOL_OUTPUT_CHARS + 3
        );
    }

    #[test]
    fn bounded_output_drains_the_reader_after_retention_limit() {
        tauri::async_runtime::block_on(async {
            let (mut writer, reader) = tokio::io::duplex(64);
            let write = tokio::spawn(async move {
                writer.write_all(&vec![b'x'; 4096]).await.unwrap();
                writer.shutdown().await.unwrap();
            });
            let (retained, truncated) = read_bounded_output(reader, 16).await.unwrap();
            write.await.unwrap();
            assert_eq!(retained, vec![b'x'; 16]);
            assert!(truncated);
        });
    }

    #[test]
    fn cancellation_blocks_mutating_tools_before_they_write() {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("traceframe-cancel-test-{nonce}"));
        std::fs::create_dir_all(&root).unwrap();
        let workspace = root.canonicalize().unwrap();
        let access = WorkspaceAccess::default();
        access.register(workspace.clone()).unwrap();
        let cancellation = AtomicBool::new(true);
        let error = tauri::async_runtime::block_on(execute_tool(
            "create_file",
            r#"{"path":"blocked.txt","content":"must not exist"}"#,
            &workspace,
            &access,
            &cancellation,
        ))
        .unwrap_err();
        assert!(error.contains("cancelled"));
        assert!(!workspace.join("blocked.txt").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    fn serve_once(status: u16, body: Vec<u8>, body_delay: Duration) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(1)))
                .unwrap();
            let mut request = [0u8; 4096];
            let _ = stream.read(&mut request);
            let reason = if status == 401 {
                "Unauthorized"
            } else {
                "Internal Server Error"
            };
            let headers = format!(
                "HTTP/1.1 {status} {reason}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let _ = stream.write_all(headers.as_bytes());
            let _ = stream.flush();
            thread::sleep(body_delay);
            let _ = stream.write_all(&body);
        });
        format!("http://{address}/v1")
    }

    fn read_http_request(stream: &mut std::net::TcpStream) -> String {
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut request = Vec::new();
        let mut chunk = [0u8; 4096];
        let (header_end, content_length) = loop {
            let count = stream.read(&mut chunk).unwrap();
            assert!(count > 0, "request ended before headers were complete");
            request.extend_from_slice(&chunk[..count]);
            let Some(header_end) = request.windows(4).position(|window| window == b"\r\n\r\n")
            else {
                continue;
            };
            let headers = String::from_utf8_lossy(&request[..header_end]);
            let content_length = headers
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().unwrap())
                })
                .unwrap_or(0);
            break (header_end + 4, content_length);
        };
        while request.len() < header_end + content_length {
            let count = stream.read(&mut chunk).unwrap();
            assert!(count > 0, "request ended before its body was complete");
            request.extend_from_slice(&chunk[..count]);
        }
        String::from_utf8(request).unwrap()
    }

    fn serve_http_sequence(
        responses: Vec<(u16, &'static str, String)>,
    ) -> (String, mpsc::Receiver<Vec<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (sender, receiver) = mpsc::channel();
        thread::spawn(move || {
            let mut requests = Vec::new();
            for (status, content_type, body) in responses {
                let (mut stream, _) = listener.accept().unwrap();
                requests.push(read_http_request(&mut stream));
                let headers = format!(
                    "HTTP/1.1 {status} OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                stream.write_all(headers.as_bytes()).unwrap();
                stream.write_all(body.as_bytes()).unwrap();
            }
            sender.send(requests).unwrap();
        });
        (format!("http://{address}/v1"), receiver)
    }

    fn serve_anthropic_stream() -> (String, mpsc::Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (sender, receiver) = mpsc::channel();
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut request = Vec::new();
            let mut chunk = [0u8; 4096];
            let (header_end, content_length) = loop {
                let count = stream.read(&mut chunk).unwrap();
                assert!(count > 0, "request ended before headers were complete");
                request.extend_from_slice(&chunk[..count]);
                let Some(header_end) = request.windows(4).position(|window| window == b"\r\n\r\n")
                else {
                    continue;
                };
                let headers = String::from_utf8_lossy(&request[..header_end]);
                let content_length = headers
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().unwrap())
                    })
                    .unwrap_or(0);
                break (header_end + 4, content_length);
            };
            while request.len() < header_end + content_length {
                let count = stream.read(&mut chunk).unwrap();
                assert!(count > 0, "request ended before its body was complete");
                request.extend_from_slice(&chunk[..count]);
            }
            sender.send(String::from_utf8(request).unwrap()).unwrap();

            let body = concat!(
                "event: message_start\n",
                "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":11,\"output_tokens\":0}}}\n\n",
                "event: content_block_delta\n",
                "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"Hello \"}}\n\n",
                "event: content_block_delta\n",
                "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"world\"}}\n\n",
                "event: message_delta\n",
                "data: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":3}}\n\n",
                "event: message_stop\n",
                "data: {\"type\":\"message_stop\"}\n\n"
            );
            let headers = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            stream.write_all(headers.as_bytes()).unwrap();
            stream.write_all(body.as_bytes()).unwrap();
        });
        (format!("http://{address}/v1"), receiver)
    }

    #[test]
    fn validates_provider_urls_and_parses_sse() {
        assert_eq!(
            api_url("https://api.example.com/v1", "models")
                .unwrap()
                .as_str(),
            "https://api.example.com/v1/models"
        );
        assert!(api_url("file:///tmp/provider", "models").is_err());
        assert!(api_url("https://user:secret@example.com/v1", "models").is_err());
        assert!(api_url("http://api.example.com/v1", "models").is_err());
        assert!(api_url("http://localhost:11434/v1", "models").is_ok());
        assert!(api_url("http://127.0.0.1:11434/v1", "models").is_ok());
        assert!(api_url("http://[::1]:11434/v1", "models").is_ok());

        let mut buffer = b"data: {\"choices\":[]}\r\n\r\ndata: [DONE]\n\n".to_vec();
        let first = take_sse_block(&mut buffer).unwrap();
        assert_eq!(parse_sse_data(&first).unwrap(), "{\"choices\":[]}");
        let second = take_sse_block(&mut buffer).unwrap();
        assert_eq!(parse_sse_data(&second).unwrap(), "[DONE]");
    }

    #[test]
    fn extracts_only_current_models_advertised_by_the_provider() {
        assert_eq!(
            super::extract_models(&json!({
                "data": [
                    { "id": "model-z" },
                    { "name": "model-a" },
                    { "id": " model-z " },
                    { "id": "" },
                    { "object": "model" }
                ]
            })),
            vec!["model-a", "model-z"]
        );
        assert_eq!(
            super::extract_models(&json!({ "models": ["local-b", "local-a"] })),
            vec!["local-a", "local-b"]
        );
        assert!(super::extract_models(&json!({ "data": [] })).is_empty());
    }

    #[test]
    fn cc_switch_health_discovers_models_without_forwarding_renderer_credentials() {
        let (endpoint, received) = serve_http_sequence(vec![
            (200, "application/json", r#"{"status":"healthy"}"#.into()),
            (
                200,
                "application/json",
                r#"{"object":"list","data":[{"id":"current-model-b"},{"id":"current-model-a"}]}"#
                    .into(),
            ),
        ]);
        let mut provider = provider(endpoint);
        provider.adapter = "cc-switch-responses".into();
        provider.api_key = "must-not-be-forwarded".into();

        let health = tauri::async_runtime::block_on(provider_healthcheck_with_timeout(
            provider,
            Duration::from_secs(2),
        ))
        .unwrap();
        assert!(health.ok);
        assert_eq!(health.authenticated, None);
        assert_eq!(health.models, vec!["current-model-a", "current-model-b"]);

        let requests = received.recv_timeout(Duration::from_secs(1)).unwrap();
        assert!(requests[0].starts_with("GET /health HTTP/1.1\r\n"));
        assert!(requests[1].starts_with("GET /v1/models HTTP/1.1\r\n"));
        assert!(requests
            .iter()
            .all(|request| !request.to_ascii_lowercase().contains("authorization:")));
    }

    #[test]
    fn cc_switch_distinguishes_an_empty_catalog_from_discovery_failure() {
        let (empty_endpoint, empty_received) = serve_http_sequence(vec![
            (200, "application/json", r#"{"status":"healthy"}"#.into()),
            (200, "application/json", r#"{"models":[]}"#.into()),
        ]);
        let mut empty_provider = provider(empty_endpoint);
        empty_provider.adapter = "cc-switch-responses".into();
        let empty_health = tauri::async_runtime::block_on(provider_healthcheck_with_timeout(
            empty_provider,
            Duration::from_secs(2),
        ))
        .unwrap();
        assert!(empty_health.ok);
        assert!(empty_health.models.is_empty());
        assert!(empty_health.detail.contains("no models were advertised"));
        assert_eq!(
            empty_received
                .recv_timeout(Duration::from_secs(1))
                .unwrap()
                .len(),
            2
        );

        let (failed_endpoint, failed_received) = serve_http_sequence(vec![
            (200, "application/json", r#"{"status":"healthy"}"#.into()),
            (
                500,
                "application/json",
                r#"{"error":"upstream unavailable"}"#.into(),
            ),
        ]);
        let mut failed_provider = provider(failed_endpoint);
        failed_provider.adapter = "cc-switch-responses".into();
        let failed_health = tauri::async_runtime::block_on(provider_healthcheck_with_timeout(
            failed_provider,
            Duration::from_secs(2),
        ))
        .unwrap();
        assert!(failed_health.ok);
        assert!(failed_health.models.is_empty());
        assert!(failed_health.detail.contains("model discovery failed"));
        assert!(failed_health.detail.contains("500"));
        assert_eq!(
            failed_received
                .recv_timeout(Duration::from_secs(1))
                .unwrap()
                .len(),
            2
        );
    }

    #[test]
    fn cc_switch_responses_request_uses_native_contract_and_preserves_tool_output() {
        let (endpoint, received) = serve_http_sequence(vec![
            (200, "application/json", "{}".into()),
            (200, "application/json", "{}".into()),
            (200, "application/json", "{}".into()),
        ]);
        let mut provider = provider(endpoint);
        provider.adapter = "cc-switch-responses".into();
        provider.model = "discovered-model".into();
        provider.api_key = "must-not-be-forwarded".into();
        let first_input = vec![json!({ "role": "user", "content": "Inspect the workspace" })];
        let continued_input = vec![
            json!({
                "type": "function_call",
                "call_id": "call-1",
                "name": "read_file",
                "arguments": "{\"path\":\"src/main.rs\"}"
            }),
            json!({
                "type": "function_call_output",
                "call_id": "call-1",
                "output": "fn main() {}"
            }),
        ];

        tauri::async_runtime::block_on(async {
            let first = send_responses_request(
                &provider,
                "Use tools",
                &first_input,
                true,
                AgentProfile::Root,
                true,
            )
            .await
            .unwrap();
            assert!(first.status().is_success());
            let second = send_responses_request(
                &provider,
                "Use tools",
                &continued_input,
                true,
                AgentProfile::Root,
                true,
            )
            .await
            .unwrap();
            assert!(second.status().is_success());
            let final_response = send_responses_request(
                &provider,
                "Return the final answer",
                &continued_input,
                false,
                AgentProfile::Root,
                false,
            )
            .await
            .unwrap();
            assert!(final_response.status().is_success());
        });

        let requests = received.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(requests.len(), 3);
        for request in &requests[..2] {
            assert!(request.starts_with("POST /v1/responses HTTP/1.1\r\n"));
            assert!(!request.to_ascii_lowercase().contains("authorization:"));
            let body: serde_json::Value =
                serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap();
            assert_eq!(body["model"], "discovered-model");
            assert_eq!(body["stream"], true);
            assert_eq!(body["store"], false);
            assert_eq!(body["include"], json!(["reasoning.encrypted_content"]));
            assert_eq!(body["tool_choice"], "auto");
            assert_eq!(body["parallel_tool_calls"], false);
            assert!(!body["tools"].as_array().unwrap().is_empty());
        }
        let continuation: serde_json::Value =
            serde_json::from_str(requests[1].split_once("\r\n\r\n").unwrap().1).unwrap();
        assert_eq!(continuation["input"][1]["type"], "function_call_output");
        assert_eq!(continuation["input"][1]["call_id"], "call-1");
        let final_request: serde_json::Value =
            serde_json::from_str(requests[2].split_once("\r\n\r\n").unwrap().1).unwrap();
        assert!(final_request.get("tools").is_none());
        assert!(final_request.get("tool_choice").is_none());
        assert!(final_request.get("parallel_tool_calls").is_none());
    }

    #[test]
    fn cc_switch_runtime_rejects_non_loopback_endpoints() {
        let mut provider = provider("https://api.example.com/v1".into());
        provider.adapter = "cc-switch-responses".into();
        let error = tauri::async_runtime::block_on(send_responses_request(
            &provider,
            "Use tools",
            &[json!({ "role": "user", "content": "Inspect" })],
            true,
            AgentProfile::Root,
            true,
        ))
        .unwrap_err();
        assert!(error.contains("loopback"));
    }

    #[test]
    fn responses_tools_are_strict_and_cover_the_workspace_loop() {
        let tools = tool_definitions(AgentProfile::Root, true);
        let names = tools
            .iter()
            .filter_map(|tool| tool.get("name").and_then(serde_json::Value::as_str))
            .collect::<Vec<_>>();
        assert_eq!(
            names,
            vec![
                "list_files",
                "read_file",
                "edit_file",
                "write_file",
                "create_file",
                "git_status",
                "git_diff",
                "run_command",
                "delegate_task"
            ]
        );
        assert!(tools.iter().all(|tool| tool["strict"] == true));
        let worker_tools = tool_definitions(AgentProfile::Worker, false);
        assert!(worker_tools
            .iter()
            .all(|tool| tool["name"] != "delegate_task"));
        let scout_tools = tool_definitions(AgentProfile::Scout, false);
        let scout_names = scout_tools
            .iter()
            .filter_map(|tool| tool["name"].as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            scout_names,
            vec!["list_files", "read_file", "git_status", "git_diff"]
        );
        let delegate = tools
            .iter()
            .find(|tool| tool["name"] == "delegate_task")
            .unwrap();
        let properties = delegate["parameters"]["properties"].as_object().unwrap();
        assert_eq!(properties.len(), 4);
        assert!(!properties.contains_key("workspace"));
        assert!(!properties.contains_key("provider"));
        assert!(!properties.contains_key("model"));
    }

    #[test]
    fn responses_agent_runs_a_bounded_auditable_specialist() {
        let root_delegate = concat!(
            "data: {\"type\":\"response.completed\",\"response\":{\"output\":[{\"type\":\"function_call\",\"call_id\":\"delegate-1\",\"name\":\"delegate_task\",\"arguments\":\"{\\\"name\\\":\\\"Audit\\\",\\\"role\\\":\\\"Test\\\",\\\"profile\\\":\\\"reviewer\\\",\\\"task\\\":\\\"Read note.txt and report its content\\\"}\"}],\"usage\":{\"input_tokens\":10}}}\n\n"
        );
        let child_read = concat!(
            "data: {\"type\":\"response.completed\",\"response\":{\"output\":[{\"type\":\"function_call\",\"call_id\":\"read-1\",\"name\":\"read_file\",\"arguments\":\"{\\\"path\\\":\\\"note.txt\\\"}\"}],\"usage\":{\"input_tokens\":8}}}\n\n"
        );
        let child_done = concat!(
            "data: {\"type\":\"response.completed\",\"response\":{\"output\":[{\"type\":\"message\",\"content\":[{\"type\":\"output_text\",\"text\":\"The note contains hello.\"}]}],\"usage\":{\"output_tokens\":6}}}\n\n"
        );
        let root_done = concat!(
            "data: {\"type\":\"response.completed\",\"response\":{\"output\":[{\"type\":\"message\",\"content\":[{\"type\":\"output_text\",\"text\":\"Specialist verified the note.\"}]}],\"usage\":{\"output_tokens\":7}}}\n\n"
        );
        let (endpoint, received) = serve_http_sequence(vec![
            (200, "text/event-stream", root_delegate.into()),
            (200, "text/event-stream", child_read.into()),
            (200, "text/event-stream", child_done.into()),
            (200, "text/event-stream", root_done.into()),
        ]);
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("traceframe-agent-test-{nonce}"));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("note.txt"), "hello").unwrap();
        let workspace = root.canonicalize().unwrap();
        let store = AppStore::default();
        store.initialize(root.join("traceframe.sqlite3")).unwrap();
        let session = store
            .create_session_record(
                "Agent test".into(),
                "main".into(),
                workspace.to_string_lossy().into(),
            )
            .unwrap();
        let access = WorkspaceAccess::default();
        access.register(workspace.clone()).unwrap();
        let request = RuntimeRequest {
            run_id: "run-agent-test".into(),
            session_id: session.id,
            workspace_path: workspace.to_string_lossy().into(),
            branch: "main".into(),
            prompt: "Use a specialist".into(),
            provider: ProviderConfig {
                adapter: "openai-responses".into(),
                ..provider(endpoint)
            },
        };
        let delivered = Arc::new(Mutex::new(Vec::new()));
        let delivered_for_channel = delivered.clone();
        let channel = tauri::ipc::Channel::new(move |body| {
            delivered_for_channel
                .lock()
                .unwrap()
                .push(body.deserialize::<serde_json::Value>().unwrap());
            Ok(())
        });
        let cancellation = AtomicBool::new(false);
        let mut sequence = 0;
        let root_agent = AgentContext {
            id: "root".into(),
            parent_id: None,
            name: "Root".into(),
            role: "Orchestrator".into(),
            task: request.prompt.clone(),
            allow_delegate: true,
            profile: AgentProfile::Root,
        };
        let mut budget = AgentBudget::default();
        let outcome = tauri::async_runtime::block_on(run_responses_agent(
            &request,
            &workspace,
            "Use tools",
            vec![json!({ "role": "user", "content": request.prompt })],
            &channel,
            &store,
            &access,
            &cancellation,
            &mut sequence,
            &root_agent,
            &mut budget,
        ))
        .unwrap()
        .unwrap();
        assert_eq!(outcome.text, "Specialist verified the note.");
        assert_eq!(budget.delegated, 1);

        let requests = received.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(requests.len(), 4);
        let request_bodies = requests
            .iter()
            .map(|request| {
                serde_json::from_str::<serde_json::Value>(request.split_once("\r\n\r\n").unwrap().1)
                    .unwrap()
            })
            .collect::<Vec<_>>();
        assert!(request_bodies[0]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|tool| tool["name"] == "delegate_task"));
        assert!(request_bodies[1]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .all(|tool| tool["name"] != "delegate_task"));
        assert_eq!(request_bodies[1]["model"], request_bodies[0]["model"]);

        let event_types = delivered
            .lock()
            .unwrap()
            .iter()
            .filter_map(|event| event["type"].as_str().map(str::to_owned))
            .collect::<Vec<_>>();
        let started = event_types
            .iter()
            .position(|event| event == "agent.started")
            .unwrap();
        let completed = event_types
            .iter()
            .position(|event| event == "agent.completed")
            .unwrap();
        assert!(started < completed);
        let delivered = delivered.lock().unwrap();
        assert!(
            delivered.iter().any(|event| {
                event["type"] == "tool.completed"
                    && event["payload"]["agentId"]
                        .as_str()
                        .is_some_and(|id| id.ends_with("-agent-1"))
            }),
            "expected a child tool completion event, received {delivered:#?}"
        );

        drop(store);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn responses_agent_synthesizes_after_the_tool_round_budget() {
        let mut responses = (0..MAX_TOOL_ROUNDS)
            .map(|round| {
                let event = json!({
                    "type": "response.completed",
                    "response": {
                        "output": [{
                            "type": "function_call",
                            "call_id": format!("list-{round}"),
                            "name": "list_files",
                            "arguments": "{}"
                        }],
                        "usage": { "input_tokens": round + 1 }
                    }
                });
                (200, "text/event-stream", format!("data: {event}\n\n"))
            })
            .collect::<Vec<_>>();
        let final_event = json!({
            "type": "response.completed",
            "response": {
                "output": [{
                    "type": "message",
                    "content": [{
                        "type": "output_text",
                        "text": "I reached the tool budget and summarized the completed inspection."
                    }]
                }],
                "usage": { "output_tokens": 9 }
            }
        });
        responses.push((200, "text/event-stream", format!("data: {final_event}\n\n")));
        let (endpoint, received) = serve_http_sequence(responses);

        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("traceframe-round-budget-test-{nonce}"));
        std::fs::create_dir_all(&root).unwrap();
        let workspace = root.canonicalize().unwrap();
        let store = AppStore::default();
        store.initialize(root.join("traceframe.sqlite3")).unwrap();
        let session = store
            .create_session_record(
                "Round budget test".into(),
                "main".into(),
                workspace.to_string_lossy().into(),
            )
            .unwrap();
        let access = WorkspaceAccess::default();
        access.register(workspace.clone()).unwrap();
        let request = RuntimeRequest {
            run_id: "run-round-budget-test".into(),
            session_id: session.id,
            workspace_path: workspace.to_string_lossy().into(),
            branch: "main".into(),
            prompt: "Inspect until the tool budget is exhausted".into(),
            provider: ProviderConfig {
                adapter: "openai-responses".into(),
                ..provider(endpoint)
            },
        };
        let channel = tauri::ipc::Channel::new(|_| Ok(()));
        let cancellation = AtomicBool::new(false);
        let mut sequence = 0;
        let root_agent = AgentContext {
            id: "root".into(),
            parent_id: None,
            name: "Root".into(),
            role: "Orchestrator".into(),
            task: request.prompt.clone(),
            allow_delegate: true,
            profile: AgentProfile::Root,
        };
        let mut budget = AgentBudget::default();

        let outcome = tauri::async_runtime::block_on(run_responses_agent(
            &request,
            &workspace,
            "Use tools when needed",
            vec![json!({ "role": "user", "content": request.prompt })],
            &channel,
            &store,
            &access,
            &cancellation,
            &mut sequence,
            &root_agent,
            &mut budget,
        ))
        .unwrap()
        .unwrap();

        assert_eq!(
            outcome.text,
            "I reached the tool budget and summarized the completed inspection."
        );
        assert_eq!(outcome.rounds, MAX_TOOL_ROUNDS + 1);
        let requests = received.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(requests.len(), MAX_TOOL_ROUNDS + 1);
        let final_request: serde_json::Value =
            serde_json::from_str(requests[MAX_TOOL_ROUNDS].split_once("\r\n\r\n").unwrap().1)
                .unwrap();
        assert!(final_request.get("tools").is_none());
        assert!(final_request.get("tool_choice").is_none());
        assert!(final_request.get("parallel_tool_calls").is_none());
        assert!(final_request["instructions"]
            .as_str()
            .unwrap()
            .contains("tool budget is exhausted"));

        drop(store);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn responses_agent_rejects_tool_calls_after_the_tool_round_budget() {
        let mut responses = (0..MAX_TOOL_ROUNDS)
            .map(|round| {
                let event = json!({
                    "type": "response.completed",
                    "response": {
                        "output": [{
                            "type": "function_call",
                            "call_id": format!("list-{round}"),
                            "name": "list_files",
                            "arguments": "{}"
                        }]
                    }
                });
                (200, "text/event-stream", format!("data: {event}\n\n"))
            })
            .collect::<Vec<_>>();
        let final_event = json!({
            "type": "response.completed",
            "response": {
                "output": [{
                    "type": "function_call",
                    "call_id": "disallowed-final-tool",
                    "name": "list_files",
                    "arguments": "{}"
                }]
            }
        });
        responses.push((200, "text/event-stream", format!("data: {final_event}\n\n")));
        let (endpoint, received) = serve_http_sequence(responses);

        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("traceframe-final-tool-test-{nonce}"));
        std::fs::create_dir_all(&root).unwrap();
        let workspace = root.canonicalize().unwrap();
        let store = AppStore::default();
        store.initialize(root.join("traceframe.sqlite3")).unwrap();
        let session = store
            .create_session_record(
                "Final tool rejection test".into(),
                "main".into(),
                workspace.to_string_lossy().into(),
            )
            .unwrap();
        let access = WorkspaceAccess::default();
        access.register(workspace.clone()).unwrap();
        let request = RuntimeRequest {
            run_id: "run-final-tool-rejection-test".into(),
            session_id: session.id,
            workspace_path: workspace.to_string_lossy().into(),
            branch: "main".into(),
            prompt: "Keep requesting tools".into(),
            provider: ProviderConfig {
                adapter: "openai-responses".into(),
                ..provider(endpoint)
            },
        };
        let channel = tauri::ipc::Channel::new(|_| Ok(()));
        let cancellation = AtomicBool::new(false);
        let mut sequence = 0;
        let root_agent = AgentContext {
            id: "root".into(),
            parent_id: None,
            name: "Root".into(),
            role: "Orchestrator".into(),
            task: request.prompt.clone(),
            allow_delegate: true,
            profile: AgentProfile::Root,
        };
        let mut budget = AgentBudget::default();

        let error = tauri::async_runtime::block_on(run_responses_agent(
            &request,
            &workspace,
            "Use tools when needed",
            vec![json!({ "role": "user", "content": request.prompt })],
            &channel,
            &store,
            &access,
            &cancellation,
            &mut sequence,
            &root_agent,
            &mut budget,
        ))
        .unwrap_err();

        assert!(error.contains("requested tools after the tool budget was exhausted"));
        let requests = received.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(requests.len(), MAX_TOOL_ROUNDS + 1);

        drop(store);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn responses_context_injects_scoped_memory_without_repeating_current_request() {
        let request = RuntimeRequest {
            run_id: "run-1".into(),
            session_id: "session-1".into(),
            workspace_path: "/tmp/project".into(),
            branch: "main".into(),
            prompt: "Implement the parser".into(),
            provider: provider("http://127.0.0.1:1/v1".into()),
        };
        let messages = vec![
            MessageRecord {
                id: "message-1".into(),
                session_id: request.session_id.clone(),
                author: "You".into(),
                role: "user".into(),
                body: "Keep compatibility".into(),
                meta: String::new(),
                created_at: 1,
            },
            MessageRecord {
                id: "message-2".into(),
                session_id: request.session_id.clone(),
                author: "You".into(),
                role: "user".into(),
                body: request.prompt.clone(),
                meta: String::new(),
                created_at: 2,
            },
        ];
        let memories = vec![MemoryRecord {
            id: "memory-1".into(),
            session_id: Some(request.session_id.clone()),
            workspace_path: request.workspace_path.clone(),
            scope: "session".into(),
            title: "Compatibility".into(),
            detail: "Keep the public API stable".into(),
            kind: "constraint".into(),
            created_at: 1,
        }];
        let instructions = agent_instructions(&request, "Parser work is in progress", &memories);
        let input = responses_input(&messages, &request.prompt);
        assert!(instructions.contains("Parser work is in progress"));
        assert!(instructions.contains("[session / constraint] Compatibility"));
        assert!(input
            .iter()
            .any(|item| item["content"] == "Keep compatibility"));
        assert_eq!(
            input
                .iter()
                .filter(|item| item["content"] == "Implement the parser")
                .count(),
            1
        );
    }

    #[test]
    fn responses_output_and_terminal_errors_are_normalized() {
        let output = vec![json!({
            "type": "message",
            "content": [
                { "type": "output_text", "text": "Hello " },
                { "type": "output_text", "text": "world" }
            ]
        })];
        assert_eq!(response_output_text(&output), "Hello world");
        assert_eq!(
            response_failure(&json!({
                "type": "response.failed",
                "response": { "error": { "message": "upstream failed" } }
            }))
            .as_deref(),
            Some("upstream failed")
        );
        assert!(response_failure(&json!({ "type": "response.completed" })).is_none());
    }

    #[test]
    fn anthropic_messages_request_and_stream_match_the_native_api() {
        let (endpoint, received) = serve_anthropic_stream();
        let mut provider = provider(endpoint);
        provider.adapter = "anthropic".into();
        provider.model = "claude-test".into();
        let messages = vec![
            json!({ "role": "user", "content": "Previous request" }),
            json!({ "role": "assistant", "content": "Previous answer" }),
            json!({ "role": "user", "content": "Current request" }),
        ];

        let bytes = tauri::async_runtime::block_on(async {
            let response = send_anthropic_request(&provider, "System context", &messages)
                .await
                .unwrap();
            assert!(response.status().is_success());
            response.bytes().await.unwrap()
        });
        let request = received.recv_timeout(Duration::from_secs(1)).unwrap();
        assert!(request.starts_with("POST /v1/messages HTTP/1.1\r\n"));
        let lower_request = request.to_ascii_lowercase();
        assert!(lower_request.contains("x-api-key: test-secret\r\n"));
        assert!(lower_request.contains("anthropic-version: 2023-06-01\r\n"));
        let body: serde_json::Value =
            serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap();
        assert_eq!(body["model"], "claude-test");
        assert_eq!(body["system"], "System context");
        assert_eq!(body["max_tokens"], ANTHROPIC_MAX_TOKENS);
        assert_eq!(body["stream"], true);
        assert_eq!(body["messages"].as_array().unwrap().len(), 3);

        let mut buffer = bytes.to_vec();
        let mut text = String::new();
        let mut usage = serde_json::Value::Null;
        let mut stopped = false;
        while let Some(block) = take_sse_block(&mut buffer) {
            let data = parse_sse_data(&block).unwrap();
            let value: serde_json::Value = serde_json::from_str(&data).unwrap();
            if let Some(delta) = anthropic_delta(&value) {
                text.push_str(delta);
            }
            if let Some(next_usage) = anthropic_usage(&value) {
                merge_usage(&mut usage, next_usage);
            }
            stopped |=
                value.get("type").and_then(serde_json::Value::as_str) == Some("message_stop");
        }
        assert_eq!(text, "Hello world");
        assert_eq!(usage["input_tokens"], 11);
        assert_eq!(usage["output_tokens"], 3);
        assert!(stopped);
    }

    #[test]
    fn provider_healthcheck_deadline_includes_a_slow_error_body() {
        let endpoint = serve_once(
            500,
            b"late provider error".to_vec(),
            Duration::from_millis(400),
        );
        let started = Instant::now();
        let error = tauri::async_runtime::block_on(provider_healthcheck_with_timeout(
            provider(endpoint),
            Duration::from_millis(80),
        ))
        .unwrap_err();
        assert!(error.contains("timed out"));
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn provider_error_body_is_bounded() {
        let endpoint = serve_once(500, vec![b'x'; MAX_ERROR_BYTES + 16 * 1024], Duration::ZERO);
        let started = Instant::now();
        let health = tauri::async_runtime::block_on(provider_healthcheck_with_timeout(
            provider(endpoint),
            Duration::from_secs(2),
        ))
        .unwrap();
        assert!(!health.ok);
        assert_eq!(health.status, Some(500));
        assert!(health.detail.len() <= MAX_ERROR_BYTES + 64);
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn pending_provider_request_honors_cancellation_before_headers() {
        let cancellation = AtomicBool::new(true);
        let result = tauri::async_runtime::block_on(await_cancellable_response(
            std::future::pending(),
            &cancellation,
        ))
        .unwrap();
        assert!(result.is_none());
    }

    #[test]
    #[cfg(unix)]
    fn terminate_child_kills_and_reaps_the_process() {
        tauri::async_runtime::block_on(async {
            let mut command = Command::new("/bin/sleep");
            command.arg("30").process_group(0);
            let mut child = command.spawn().unwrap();
            terminate_child(&mut child).await.unwrap();
            assert!(child.try_wait().unwrap().is_some());
        });
    }

    #[test]
    #[cfg(unix)]
    fn terminate_child_stops_the_spawned_process_group() {
        tauri::async_runtime::block_on(async {
            let nonce = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let pid_file = std::env::temp_dir().join(format!("traceframe-child-pid-{nonce}"));
            let mut command = Command::new("/bin/sh");
            command
                .arg("-c")
                .arg("sleep 30 & echo $! > \"$TRACEFRAME_PID_FILE\"; wait")
                .env("TRACEFRAME_PID_FILE", &pid_file)
                .process_group(0);
            let mut child = command.spawn().unwrap();
            for _ in 0..100 {
                if pid_file.exists() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            let descendant = std::fs::read_to_string(&pid_file).unwrap();
            terminate_child(&mut child).await.unwrap();
            let mut alive = true;
            for _ in 0..100 {
                alive = std::process::Command::new("/bin/kill")
                    .args(["-0", descendant.trim()])
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .status()
                    .unwrap()
                    .success();
                if !alive {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            assert!(!alive, "descendant process survived cancellation");
            let _ = std::fs::remove_file(pid_file);
        });
    }
}
